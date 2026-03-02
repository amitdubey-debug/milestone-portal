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
 */
const subscribers = new Map();
function publish(orderNumber, event) {
  const subs = subscribers.get(orderNumber);
  if (!subs) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) res.write(data);
}

/**
 * Pages
 */
app.get("/", (req, res) => res.redirect("/generate"));
app.get("/generate", (req, res) => res.sendFile(path.join(__dirname, "public", "generate.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/milestone", (req, res) => res.sendFile(path.join(__dirname, "public", "milestone.html")));
app.get("/oneclick", (req, res) => res.sendFile(path.join(__dirname, "public", "oneclick.html")));

/**
 * POST /api/link
 */
app.post("/api/link", async (req, res) => {
  const { orderNumber, pickupLocation, deliveryLocation, ttlMinutes } = req.body || {};

  if (!orderNumber || !pickupLocation || !deliveryLocation) {
    return res.status(400).json({
      error: "Missing required fields: orderNumber, pickupLocation, deliveryLocation"
    });
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

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const baseUrl = `${proto}://${host}`;

  const link = `${baseUrl}/milestone?token=${encodeURIComponent(token)}`;
  const dashboard = `${baseUrl}/dashboard?order=${encodeURIComponent(orderNumber)}`;

  // QR points to oneclick page by default (faster for drivers)
  const oneclickDefault = `${baseUrl}/oneclick?token=${encodeURIComponent(token)}&type=PICKED_UP`;
  const qrPngBuffer = await QRCode.toBuffer(oneclickDefault, { width: 340, margin: 1 });
  const qrDataUrl = `data:image/png;base64,${qrPngBuffer.toString("base64")}`;

  res.json({ link, dashboard, token, expiresInMinutes: effectiveTtl, qrDataUrl });
});

/**
 * Token context
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
 */
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

/**
 * Submit milestone
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
 * PDF with clickable "buttons" (they are links to /oneclick)
 */
app.post("/api/pdf", async (req, res) => {
  const { orderNumber, pickupLocation, deliveryLocation, expiresInMinutes, token } = req.body || {};

  if (!orderNumber || !pickupLocation || !deliveryLocation || !token) {
    return res.status(400).json({ error: "Missing required fields for PDF" });
  }

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const baseUrl = `${proto}://${host}`;

  const pickupUrl = `${baseUrl}/oneclick?token=${encodeURIComponent(token)}&type=PICKED_UP`;
  const deliveredUrl = `${baseUrl}/oneclick?token=${encodeURIComponent(token)}&type=DELIVERED`;
  const delayUrl = `${baseUrl}/oneclick?token=${encodeURIComponent(token)}&type=DELAY`;

  // QR points to oneclick pickup (fast path)
  const qrPngBuffer = await QRCode.toBuffer(pickupUrl, { width: 460, margin: 1 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="milestone-qr-${String(orderNumber).replace(/[^a-zA-Z0-9_-]/g, "")}.pdf"`
  );

  const doc = new PDFDocument({ size: "A4", margin: 44 });
  doc.pipe(res);

  const left = doc.page.margins.left;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Title
  doc.font("Helvetica-Bold").fontSize(18).text("Milestone Update", left, 56);
  doc.font("Helvetica").fontSize(11).fillColor("#555")
    .text("Tap a button below (PDF) → it opens a web page and submits with GPS.", left, 78);
  doc.fillColor("#000");

  // Divider
  doc.moveTo(left, 100).lineTo(left + pageWidth, 100).strokeColor("#DDD").stroke();
  doc.strokeColor("#000");

  // Details
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
  doc.moveTo(left, y).lineTo(left + pageWidth, y).strokeColor("#DDD").stroke();
  y += 18;

  // QR
  const qrSize = 220;
  doc.image(qrPngBuffer, left, y, { fit: [qrSize, qrSize] });

  // Right steps
  const stepsX = left + qrSize + 18;
  const stepsW = left + pageWidth - stepsX;

  doc.font("Helvetica-Bold").fontSize(14).text("Driver steps", stepsX, y);
  doc.font("Helvetica").fontSize(12);

  const steps = [
    "1) Tap a button in this PDF.",
    "2) Your phone browser opens.",
    "3) Allow location if asked.",
    "4) Done ✅ (event sent)."
  ];
  let sy = y + 24;
  for (const s of steps) {
    doc.text(s, stepsX, sy, { width: stepsW });
    sy += 18;
  }

  // Button-like boxes (CLICKABLE LINKS)
  y = y + qrSize + 24;

  doc.font("Helvetica-Bold").fontSize(12).text("Tap buttons (they are clickable links):", left, y);
  y += 14;

  function linkButtonBox(title, subtitle, url) {
    const h = 66;
    // rectangle
    doc.roundedRect(left, y, pageWidth, h, 10).lineWidth(1).strokeColor("#D0D0D0").stroke();
    // clickable area over the rectangle
    doc.link(left, y, pageWidth, h, url);

    doc.fillColor("#000").font("Helvetica-Bold").fontSize(12).text(title, left + 14, y + 12, { width: pageWidth - 28 });
    doc.fillColor("#666").font("Helvetica").fontSize(10).text(subtitle, left + 14, y + 32, { width: pageWidth - 28 });
    doc.fillColor("#000");

    y += h + 10;
  }

  linkButtonBox(`✅ Pick up from ${pickupLocation}`, "Tap to submit PICK UP with your current GPS.", pickupUrl);
  linkButtonBox(`✅ Delivered at ${deliveryLocation}`, "Tap to submit DELIVERED with your current GPS.", deliveredUrl);
  linkButtonBox("⚠️ Delay", "Tap to open delay page (select reason + submit with GPS).", delayUrl);

  y += 6;
  doc.moveTo(left, y).lineTo(left + pageWidth, y).strokeColor("#DDD").stroke();
  y += 14;

  doc.fillColor("#000").font("Helvetica-Bold").fontSize(12).text("Fallback link:", left, y);
  y += 16;
  doc.font("Helvetica").fontSize(9).text(pickupUrl, left, y, { width: pageWidth });

  doc.end();
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});