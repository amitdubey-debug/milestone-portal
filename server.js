import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_TTL_MINUTES = Number(process.env.TOKEN_TTL_MINUTES || 60 * 24 * 7);

const app = express();
app.set("trust proxy", 1); // ✅ important for Render (x-forwarded-proto/host)
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
const MILESTONES_FILE = path.join(DATA_DIR, "milestones.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(MILESTONES_FILE)) fs.writeFileSync(MILESTONES_FILE, JSON.stringify([], null, 2));

function readMilestones() {
  try {
    return JSON.parse(fs.readFileSync(MILESTONES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function appendMilestone(record) {
  const all = readMilestones();
  all.push(record);
  fs.writeFileSync(MILESTONES_FILE, JSON.stringify(all, null, 2));
}

/**
 * SSE subscribers keyed by orderNumber
 * order -> Set<res>
 */
const subscribers = new Map();

function publish(orderNumber, event) {
  const subs = subscribers.get(orderNumber);
  if (!subs) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) res.write(data);
}

/**
 * Portal pages
 */
app.get("/generate", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "generate.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/milestone", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "milestone.html"));
});

/**
 * MODULE 1: Generate tokenised link (derived base URL for Render)
 * POST /api/link
 * body: { orderNumber, pickupLocation, deliveryLocation, ttlMinutes }
 */
app.post("/api/link", (req, res) => {
  const { orderNumber, pickupLocation, deliveryLocation, ttlMinutes } = req.body || {};

  if (!orderNumber || !pickupLocation || !deliveryLocation) {
    return res.status(400).json({
      error: "Missing required fields: orderNumber, pickupLocation, deliveryLocation"
    });
  }

  // Allow per-link TTL; default to env; cap at 30 days
  const requested = Number(ttlMinutes);
  const maxMinutes = 60 * 24 * 30; // 30 days
  const effectiveTtl =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, maxMinutes)
      : TOKEN_TTL_MINUTES;

  const payload = {
    orderNumber: String(orderNumber),
    pickupLocation: String(pickupLocation),
    deliveryLocation: String(deliveryLocation),
    allowedMilestones: ["PICKED_UP", "DELIVERED", "DELAY"]
  };

  const token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: `${effectiveTtl}m`,
    jwtid: nanoid(16)
  });

  // ✅ derive base URL from request (works on Render)
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const baseUrl = `${proto}://${host}`;

  const link = `${baseUrl}/milestone?token=${encodeURIComponent(token)}`;
  const dashboard = `${baseUrl}/dashboard?order=${encodeURIComponent(orderNumber)}`;

  res.json({ link, dashboard, token, expiresInMinutes: effectiveTtl });
});

/**
 * Get context for token (frontend uses this to label buttons)
 * GET /api/context?token=...
 */
app.get("/api/context", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: "Missing token" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({
      orderNumber: decoded.orderNumber,
      pickupLocation: decoded.pickupLocation,
      deliveryLocation: decoded.deliveryLocation,
      allowedMilestones: decoded.allowedMilestones
    });
  } catch {
    return res.status(401).json({ error: "Invalid/expired token" });
  }
});

/**
 * SSE stream
 * GET /api/stream?order=ORDERNO
 */
app.get("/api/stream", (req, res) => {
  const order = String(req.query.order || "");
  if (!order) return res.status(400).json({ error: "Missing order" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // keep alive ping
  const keepAlive = setInterval(() => res.write(":\n\n"), 25000);

  if (!subscribers.has(order)) subscribers.set(order, new Set());
  subscribers.get(order).add(res);

  // bootstrap old events for this order
  const all = readMilestones().filter((m) => m.orderNumber === order);
  res.write(`event: bootstrap\ndata: ${JSON.stringify(all)}\n\n`);

  req.on("close", () => {
    clearInterval(keepAlive);
    const set = subscribers.get(order);
    if (set) {
      set.delete(res);
      if (set.size === 0) subscribers.delete(order);
    }
  });
});

/**
 * Submit milestone
 * POST /api/submit
 * body: { token, milestoneType, delayReason?, delayNotes?, geo? }
 */
app.post("/api/submit", (req, res) => {
  const { token, milestoneType, delayReason, delayNotes, geo } = req.body || {};

  if (!token || !milestoneType) {
    return res.status(400).json({ error: "token and milestoneType are required" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid/expired token" });
  }

  if (!decoded.allowedMilestones?.includes(milestoneType)) {
    return res.status(403).json({ error: "Milestone not allowed" });
  }

  if (milestoneType === "DELAY" && !delayReason) {
    return res.status(400).json({ error: "delayReason is required when milestoneType=DELAY" });
  }

  let cleanGeo = null;
  if (geo && typeof geo === "object") {
    const { lat, lon, accuracy } = geo;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      cleanGeo = {
        lat,
        lon,
        accuracy: Number.isFinite(accuracy) ? accuracy : null
      };
    }
  }

  const record = {
    id: nanoid(12),
    receivedAtUtc: new Date().toISOString(),
    orderNumber: decoded.orderNumber,
    milestoneType,
    delayReason: milestoneType === "DELAY" ? String(delayReason) : null,
    delayNotes: milestoneType === "DELAY" ? String(delayNotes || "") : null,
    geo: cleanGeo
  };

  appendMilestone(record);
  publish(decoded.orderNumber, record);

  res.json({ ok: true, record });
});

/**
 * Debug endpoint: get all milestones
 */
app.get("/api/milestones", (req, res) => {
  res.json(readMilestones());
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`Portal: http://localhost:${PORT}/generate`);
});