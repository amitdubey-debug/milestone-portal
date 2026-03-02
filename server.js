import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_TTL_MINUTES = Number(process.env.TOKEN_TTL_MINUTES || 60 * 24 * 7);

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Demo storage ----------
const DATA_DIR = path.join(__dirname, "data");
const MILESTONES_FILE = path.join(DATA_DIR, "milestones.json");
const SHORTLINKS_FILE = path.join(DATA_DIR, "shortlinks.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(MILESTONES_FILE)) fs.writeFileSync(MILESTONES_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(SHORTLINKS_FILE)) fs.writeFileSync(SHORTLINKS_FILE, JSON.stringify({}, null, 2));

function readMilestones() {
  try {
    return JSON.parse(fs.readFileSync(MILESTONES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function writeMilestones(all) {
  fs.writeFileSync(MILESTONES_FILE, JSON.stringify(all, null, 2));
}
function appendMilestone(record) {
  const all = readMilestones();
  all.push(record);
  writeMilestones(all);
}

function readShortlinks() {
  try {
    return JSON.parse(fs.readFileSync(SHORTLINKS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeShortlinks(obj) {
  fs.writeFileSync(SHORTLINKS_FILE, JSON.stringify(obj, null, 2));
}
function createShortCode(token) {
  const map = readShortlinks();
  const code = nanoid(8);
  map[code] = { token, createdAtUtc: new Date().toISOString() };
  writeShortlinks(map);
  return code;
}

function baseUrlFromReq(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// ---------- SSE ----------
const subscribers = new Map();
function publish(orderNumber, event) {
  const subs = subscribers.get(orderNumber);
  if (!subs) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) res.write(data);
}

// ---------- Pages ----------
app.get("/", (req, res) => res.redirect("/generate"));
app.get("/generate", (req, res) => res.sendFile(path.join(__dirname, "public", "generate.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/milestone", (req, res) => res.sendFile(path.join(__dirname, "public", "milestone.html")));
app.get("/oneclick", (req, res) => res.sendFile(path.join(__dirname, "public", "oneclick.html")));
app.get("/quick", (req, res) => res.sendFile(path.join(__dirname, "public", "quick.html")));

// ---------- Short links ----------
app.get("/s/:code", (req, res) => {
  const code = String(req.params.code || "");
  const map = readShortlinks();
  const entry = map[code];
  if (!entry?.token) return res.status(404).send("Invalid short link");

  // mode=quick -> redirect to /quick for one-tap submit UX
  const mode = String(req.query.mode || "");
  const type = req.query.type ? String(req.query.type) : "";

  const target = new URL(`${baseUrlFromReq(req)}/${mode === "quick" ? "quick" : "oneclick"}`);
  target.searchParams.set("token", entry.token);
  if (type) target.searchParams.set("type", type);

  res.redirect(target.toString());
});

// ---------- API ----------
app.post("/api/link", async (req, res) => {
  const { orderNumber, pickupLocation, deliveryLocation, ttlMinutes } = req.body || {};
  if (!orderNumber || !pickupLocation || !deliveryLocation) {
    return res.status(400).json({ error: "Missing required fields: orderNumber, pickupLocation, deliveryLocation" });
  }

  const requested = Number(ttlMinutes);
  const maxMinutes = 60 * 24 * 30;
  const effectiveTtl =
    Number.isFinite(requested) && requested > 0 ? Math.min(requested, maxMinutes) : TOKEN_TTL_MINUTES;

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

  const baseUrl = baseUrlFromReq(req);
  const link = `${baseUrl}/milestone?token=${encodeURIComponent(token)}`;

  // Landing short link should open full oneclick UI
  const landingCode = createShortCode(token);
  const shortLanding = `${baseUrl}/s/${landingCode}`;

  const dashboard = `${baseUrl}/dashboard?order=${encodeURIComponent(orderNumber)}`;

  // QR should open "landing" (full page)
  const qrPngBuffer = await QRCode.toBuffer(shortLanding, { width: 360, margin: 1 });
  const qrDataUrl = `data:image/png;base64,${qrPngBuffer.toString("base64")}`;

  res.json({ token, link, shortLanding, qrDataUrl, dashboard, expiresInMinutes: effectiveTtl });
});

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

app.get("/api/milestones", (req, res) => {
  const order = String(req.query.order || "");
  const all = readMilestones();
  if (!order) return res.json(all);
  res.json(all.filter((m) => m.orderNumber === order));
});

app.get("/api/stream", (req, res) => {
  const order = String(req.query.order || "");
  if (!order) return res.status(400).json({ error: "Missing order" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const keepAlive = setInterval(() => res.write(":\n\n"), 25000);

  if (!subscribers.has(order)) subscribers.set(order, new Set());
  subscribers.get(order).add(res);

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

app.post("/api/submit", (req, res) => {
  const { token, milestoneType, delayReason, delayNotes, geo } = req.body || {};
  if (!token || !milestoneType) return res.status(400).json({ error: "token and milestoneType are required" });

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

  // geo is OPTIONAL now (already was, but we keep it explicit)
  let cleanGeo = null;
  if (geo && typeof geo === "object") {
    const { lat, lon, accuracy } = geo;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      cleanGeo = { lat, lon, accuracy: Number.isFinite(accuracy) ? accuracy : null };
    }
  }

  const record = {
    id: nanoid(12),
    receivedAtUtc: new Date().toISOString(),
    orderNumber: decoded.orderNumber,
    milestoneType,
    delayReason: milestoneType === "DELAY" ? String(delayReason) : null,
    delayNotes: milestoneType === "DELAY" ? String(delayNotes || "") : null,
    geo: cleanGeo,
    gpsMissing: !cleanGeo // <-- flag for UI / dashboard
  };

  appendMilestone(record);
  publish(decoded.orderNumber, record);
  res.json({ ok: true, record });
});

/**
 * POST /api/ping
 * body: { token, geo?, pingSource? }
 * IMPORTANT: geo is OPTIONAL now (we store ping even if no GPS).
 */
app.post("/api/ping", (req, res) => {
  const { token, geo, pingSource } = req.body || {};
  if (!token) return res.status(400).json({ error: "token is required" });

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid/expired token" });
  }

  let cleanGeo = null;
  if (geo && typeof geo === "object") {
    const { lat, lon, accuracy } = geo;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      cleanGeo = { lat, lon, accuracy: Number.isFinite(accuracy) ? accuracy : null };
    }
  }

  const record = {
    id: nanoid(12),
    receivedAtUtc: new Date().toISOString(),
    orderNumber: decoded.orderNumber,
    milestoneType: "GPS_PING",
    pingSource: pingSource ? String(pingSource) : null,
    geo: cleanGeo,
    gpsMissing: !cleanGeo
  };

  appendMilestone(record);
  publish(decoded.orderNumber, record);
  res.json({ ok: true });
});

// ---------- PDF (UPDATED LINKS: pickup/delivered go to QUICK) ----------
app.post("/api/pdf", async (req, res) => {
  const { orderNumber, pickupLocation, deliveryLocation, expiresInMinutes, token } = req.body || {};
  if (!orderNumber || !pickupLocation || !deliveryLocation || !token) {
    return res.status(400).json({ error: "Missing required fields for PDF" });
  }

  const baseUrl = baseUrlFromReq(req);

  // Short codes:
  // - QR opens full oneclick (landing)
  // - buttons open quick submit
  const landingUrl = `${baseUrl}/s/${createShortCode(token)}`; // full UI
  const pickupUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=PICKED_UP`;
  const deliveredUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELIVERED`;
  const delayUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELAY`;

  const qrPngBuffer = await QRCode.toBuffer(landingUrl, { width: 460, margin: 1 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="milestone-qr-${String(orderNumber).replace(/[^a-zA-Z0-9_-]/g, "")}.pdf"`
  );

  const doc = new PDFDocument({ size: "A4", margin: 44 });
  doc.pipe(res);

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font("Helvetica-Bold").fontSize(18).fillColor("#000").text("Milestone Update", left, 56);
  doc.font("Helvetica").fontSize(11).fillColor("#555")
    .text("PDF buttons = one-tap submit. QR = open full page.", left, 78);
  doc.fillColor("#000");

  doc.moveTo(left, 100).lineTo(left + width, 100).strokeColor("#DDD").stroke();

  let y = 118;
  doc.font("Helvetica-Bold").fontSize(14).text(`Order: ${orderNumber}`, left, y);
  y += 22;
  doc.font("Helvetica").fontSize(12).text(`Pick up: ${pickupLocation}`, left, y);
  y += 18;
  doc.text(`Delivery: ${deliveryLocation}`, left, y);
  y += 18;
  doc.font("Helvetica").fontSize(10).fillColor("#666").text(`Link expires in ${expiresInMinutes ?? ""} minutes`, left, y);
  doc.fillColor("#000");

  y += 18;
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor("#DDD").stroke();
  y += 18;

  const qrSize = 220;
  doc.image(qrPngBuffer, left, y, { fit: [qrSize, qrSize] });

  const stepsX = left + qrSize + 18;
  const stepsW = left + width - stepsX;
  doc.font("Helvetica-Bold").fontSize(14).text("Driver steps", stepsX, y);
  doc.font("Helvetica").fontSize(12).fillColor("#000");

  const steps = ["1) Tap a PDF button (Pick up / Delivered / Delay).", "2) Browser opens.", "3) Allow location (recommended).", "4) Submitted."];
  let sy = y + 24;
  for (const s of steps) {
    doc.text(s, stepsX, sy, { width: stepsW });
    sy += 18;
  }

  y = y + qrSize + 24;
  doc.font("Helvetica-Bold").fontSize(12).text("Tap buttons (clickable links):", left, y);
  y += 14;

  function linkBox(title, subtitle, url) {
    const h = 66;
    doc.roundedRect(left, y, width, h, 10).lineWidth(1).strokeColor("#D0D0D0").stroke();
    doc.link(left, y, width, h, url);
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(12).text(title, left + 14, y + 12, { width: width - 28 });
    doc.fillColor("#666").font("Helvetica").fontSize(10).text(subtitle, left + 14, y + 32, { width: width - 28 });
    doc.fillColor("#000");
    y += h + 10;
  }

  linkBox(`[PICK UP]  ${pickupLocation}`, "One-tap submit PICKED_UP (uses GPS if allowed).", pickupUrl);
  linkBox(`[DELIVERED]  ${deliveryLocation}`, "One-tap submit DELIVERED (uses GPS if allowed).", deliveredUrl);
  linkBox(`[DELAY]`, "Opens delay reason page (then submit).", delayUrl);

  y += 6;
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor("#DDD").stroke();
  y += 14;

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#000").text("Fallback link (opens full page):", left, y);
  y += 16;

  doc.font("Helvetica").fontSize(11).fillColor("#000").text(landingUrl, left, y, { width });
  doc.link(left, y - 2, width, 16, landingUrl);

  doc.end();
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));