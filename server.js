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
  try { return JSON.parse(fs.readFileSync(MILESTONES_FILE, "utf8")); }
  catch { return []; }
}
function writeMilestones(all) { fs.writeFileSync(MILESTONES_FILE, JSON.stringify(all, null, 2)); }
function appendMilestone(record) {
  const all = readMilestones();
  all.push(record);
  writeMilestones(all);
}

function readShortlinks() {
  try { return JSON.parse(fs.readFileSync(SHORTLINKS_FILE, "utf8")); }
  catch { return {}; }
}
function writeShortlinks(obj) { fs.writeFileSync(SHORTLINKS_FILE, JSON.stringify(obj, null, 2)); }
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
app.get("/start", (req, res) => res.sendFile(path.join(__dirname, "public", "start.html")));
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

  const mode = String(req.query.mode || "");
  const type = req.query.type ? String(req.query.type) : "";

  const target = new URL(`${baseUrlFromReq(req)}/${mode === "quick" ? "quick" : "oneclick"}`);
  target.searchParams.set("token", entry.token);
  if (type) target.searchParams.set("type", type);

  res.redirect(target.toString());
});

// ---------- Helpers ----------
function mintToken({ orderNumber, pickupLocation, deliveryLocation, ttlMinutes }) {
  const requested = Number(ttlMinutes);
  const maxMinutes = 60 * 24 * 30;
  const effectiveTtl =
    Number.isFinite(requested) && requested > 0 ? Math.min(requested, maxMinutes) : TOKEN_TTL_MINUTES;

  const payload = {
    orderNumber: String(orderNumber),
    pickupLocation: String(pickupLocation || "Unknown pickup"),
    deliveryLocation: String(deliveryLocation || "Unknown delivery"),
    allowedMilestones: ["PICKED_UP", "DELIVERED", "DELAY"]
  };

  const token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: `${effectiveTtl}m`,
    jwtid: nanoid(16)
  });

  return { token, effectiveTtl };
}

// ---------- API ----------
app.post("/api/link", async (req, res) => {
  const { orderNumber, pickupLocation, deliveryLocation, ttlMinutes } = req.body || {};
  if (!orderNumber || !pickupLocation || !deliveryLocation) {
    return res.status(400).json({ error: "Missing required fields: orderNumber, pickupLocation, deliveryLocation" });
  }

  const { token, effectiveTtl } = mintToken({ orderNumber, pickupLocation, deliveryLocation, ttlMinutes });

  const baseUrl = baseUrlFromReq(req);
  const link = `${baseUrl}/milestone?token=${encodeURIComponent(token)}`;

  const landingCode = createShortCode(token);
  const shortLanding = `${baseUrl}/s/${landingCode}`;

  const dashboard = `${baseUrl}/dashboard?order=${encodeURIComponent(orderNumber)}`;

  const qrPngBuffer = await QRCode.toBuffer(shortLanding, { width: 360, margin: 1 });
  const qrDataUrl = `data:image/png;base64,${qrPngBuffer.toString("base64")}`;

  res.json({ token, link, shortLanding, qrDataUrl, dashboard, expiresInMinutes: effectiveTtl });
});

// NEW: Only orderNumber
app.post("/api/start", (req, res) => {
  const { orderNumber, ttlMinutes } = req.body || {};
  if (!orderNumber) return res.status(400).json({ error: "orderNumber is required" });

  const { token } = mintToken({ orderNumber, ttlMinutes });

  const baseUrl = baseUrlFromReq(req);
  const link = `${baseUrl}/oneclick?token=${encodeURIComponent(token)}`;
  res.json({ link });
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
  const { token, milestoneType, delayReason, delayNotes, geo, source } = req.body || {};
  if (!token || !milestoneType) return res.status(400).json({ error: "token and milestoneType are required" });

  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: "Invalid/expired token" }); }

  if (!decoded.allowedMilestones?.includes(milestoneType)) {
    return res.status(403).json({ error: "Milestone not allowed" });
  }

  if (milestoneType === "DELAY" && !delayReason) {
    return res.status(400).json({ error: "delayReason is required when milestoneType=DELAY" });
  }

  let cleanGeo = null;
  if (geo && typeof geo === "object") {
    const { lat, lon, accuracy } = geo;
    if (Number.isFinite(lat) && Number.isFinite(lon)) cleanGeo = { lat, lon, accuracy: Number.isFinite(accuracy) ? accuracy : null };
  }

  const record = {
  id: nanoid(12),
  receivedAtUtc: new Date().toISOString(),
  orderNumber: decoded.orderNumber,
  milestoneType,
  source: source ? String(source) : "WEB",
  delayReason: milestoneType === "DELAY" ? String(delayReason) : null,
  delayNotes: milestoneType === "DELAY" ? String(delayNotes || "") : null,
  geo: cleanGeo,
  gpsMissing: !cleanGeo
};

  appendMilestone(record);
  publish(decoded.orderNumber, record);
  res.json({ ok: true, record });
});

app.post("/api/ping", (req, res) => {
  const { token, geo, pingSource } = req.body || {};
  if (!token) return res.status(400).json({ error: "token is required" });

  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: "Invalid/expired token" }); }

  let cleanGeo = null;
  if (geo && typeof geo === "object") {
    const { lat, lon, accuracy } = geo;
    if (Number.isFinite(lat) && Number.isFinite(lon)) cleanGeo = { lat, lon, accuracy: Number.isFinite(accuracy) ? accuracy : null };
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

// ---------- PDF ----------
app.post("/api/pdf", async (req, res) => {
  // Values we DO have today from generate flow:
  // orderNumber, pickupLocation, deliveryLocation, token, expiresInMinutes
  // Everything else: dummy placeholders (as requested)
  const {
    orderNumber,
    pickupLocation,
    deliveryLocation,
    expiresInMinutes,
    token,

    // optional future fields (safe if not provided)
    vendorName,
    vendorCode,
    driverName,
    driverPhone,
    vehicleNo,
    trailerNo,
    bookingNo,
    customerName,
    serviceProduct,
    cargoType,
    remarks
  } = req.body || {};

  if (!orderNumber || !token) {
    return res.status(400).json({ error: "Missing required fields for PDF: orderNumber, token" });
  }

  const baseUrl = baseUrlFromReq(req);

  // ---------- Core links ----------
  // Landing = full driver page
  const landingUrl = `${baseUrl}/s/${createShortCode(token)}`;

  // PDF buttons (one-tap submit) -> quick page
  const pickupUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=PICKED_UP`;
  const deliveredUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELIVERED`;
  const delayUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELAY`;

  // ---------- WhatsApp QR ----------
  // Phone must be digits only for wa.me (no +, no dashes)
  const whatsappNumber = "447345485597"; // +44-7345485597
  const whatsappText = `Order ${orderNumber}`;
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(whatsappText)}`;

  // ---------- QR images ----------
  const landingQrPng = await QRCode.toBuffer(landingUrl, { width: 520, margin: 1 });
  const whatsappQrPng = await QRCode.toBuffer(whatsappUrl, { width: 520, margin: 1 });

  // ---------- Dummy placeholders (if missing) ----------
  const dPickup = pickupLocation || "Dummy Pickup Location";
  const dDelivery = deliveryLocation || "Dummy Delivery Location";

  const dVendorName = vendorName || "DUMMY VENDOR LTD";
  const dVendorCode = vendorCode || "VN-000000";
  const dDriverName = driverName || "DRIVER NAME";
  const dDriverPhone = driverPhone || "+00 0000 000000";
  const dVehicleNo = vehicleNo || "TRUCK-0000";
  const dTrailerNo = trailerNo || "TRL-0000";

  const dBookingNo = bookingNo || String(orderNumber);
  const dCustomerName = customerName || "DUMMY CUSTOMER";
  const dServiceProduct = serviceProduct || "Landside Transport";
  const dCargoType = cargoType || "General cargo";
  const dRemarks = remarks || "—";

  const now = new Date();
  const createdUtc = now.toISOString();

  // ---------- PDF response headers ----------
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="FRO_${String(orderNumber).replace(/[^a-zA-Z0-9_-]/g, "")}.pdf"`
  );

  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.pipe(res);

  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const pageWidth = pageRight - pageLeft;

  // Helpers
  const hLine = (y) => {
    doc.moveTo(pageLeft, y).lineTo(pageRight, y).strokeColor("#DADDE6").lineWidth(1).stroke();
  };

  const labelValue = (label, value, x, y, w) => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text(label, x, y, { width: w });
    doc.font("Helvetica").fontSize(11).fillColor("#0f172a").text(value, x, y + 12, { width: w });
  };

  const sectionTitle = (title, y) => {
    doc.roundedRect(pageLeft, y, pageWidth, 24, 8).fillColor("#EEF2FF").fill();
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#1e293b").text(title, pageLeft + 10, y + 6);
    doc.fillColor("#0f172a");
    return y + 34;
  };

  const linkBox = (title, subtitle, url, y) => {
    const h = 58;
    doc.roundedRect(pageLeft, y, pageWidth, h, 10).lineWidth(1).strokeColor("#D0D0D0").stroke();
    doc.link(pageLeft, y, pageWidth, h, url);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text(title, pageLeft + 12, y + 10, { width: pageWidth - 24 });
    doc.font("Helvetica").fontSize(10).fillColor("#64748b").text(subtitle, pageLeft + 12, y + 30, { width: pageWidth - 24 });
    doc.fillColor("#0f172a");
    return y + h + 10;
  };

  // ---------- Header (FRO-like) ----------
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text("EXPORT WORK ORDER", pageLeft, 24);
  doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(`Created (UTC): ${createdUtc}`, pageLeft, 46);
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text(`Order / WO: ${orderNumber}`, pageRight - 220, 28, { width: 220, align: "right" });
  doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(`Booking: ${dBookingNo}`, pageRight - 220, 46, { width: 220, align: "right" });

  hLine(64);

  // ---------- Top details grid ----------
  let y = 74;
  const colGap = 14;
  const colW = (pageWidth - colGap) / 2;

  labelValue("Customer", dCustomerName, pageLeft, y, colW);
  labelValue("Service / Product", dServiceProduct, pageLeft + colW + colGap, y, colW);

  y += 40;
  labelValue("Vendor", `${dVendorName} (${dVendorCode})`, pageLeft, y, colW);
  labelValue("Cargo Type", dCargoType, pageLeft + colW + colGap, y, colW);

  y += 42;
  hLine(y);
  y += 12;

  // ---------- Locations ----------
  y = sectionTitle("Locations", y);

  labelValue("Pick up", dPickup, pageLeft, y, colW);
  labelValue("Delivery", dDelivery, pageLeft + colW + colGap, y, colW);

  y += 48;
  hLine(y);
  y += 12;

  // ---------- Driver / Equipment ----------
  y = sectionTitle("Driver & Equipment", y);

  labelValue("Driver", dDriverName, pageLeft, y, colW);
  labelValue("Driver Phone", dDriverPhone, pageLeft + colW + colGap, y, colW);

  y += 40;
  labelValue("Vehicle No.", dVehicleNo, pageLeft, y, colW);
  labelValue("Trailer No.", dTrailerNo, pageLeft + colW + colGap, y, colW);

  y += 44;
  hLine(y);
  y += 12;

  // ---------- Milestone Updates (PDF buttons) ----------
  y = sectionTitle("Milestone Update (Tap buttons below)", y);

  y = linkBox(`[PICK UP]  ${dPickup}`, "One tap submit PICKED_UP (GPS if allowed).", pickupUrl, y);
  y = linkBox(`[DELIVERED]  ${dDelivery}`, "One tap submit DELIVERED (GPS if allowed).", deliveredUrl, y);
  y = linkBox(`[DELAY]`, "Opens delay reason page, then submit (GPS if allowed).", delayUrl, y);

  doc.font("Helvetica").fontSize(9).fillColor("#64748b")
    .text("Note: If location permission is blocked, the event is still submitted (without GPS).", pageLeft, y);
  doc.fillColor("#0f172a");
  y += 16;

  // ---------- QR Codes section ----------
  y = sectionTitle("Scan QR Codes", y);

  const qrSize = 170;
  // Left QR: full page
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text("Driver update page", pageLeft, y);
  doc.image(landingQrPng, pageLeft, y + 14, { fit: [qrSize, qrSize] });
  doc.font("Helvetica").fontSize(8).fillColor("#64748b")
    .text("Scan to open full page (buttons + tracking).", pageLeft, y + 14 + qrSize + 6, { width: qrSize });

  // Right QR: WhatsApp
  const rightX = pageLeft + qrSize + 30;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text("Share via WhatsApp", rightX, y);
  doc.image(whatsappQrPng, rightX, y + 14, { fit: [qrSize, qrSize] });
  doc.font("Helvetica").fontSize(8).fillColor("#64748b")
    .text(`Opens WhatsApp to +44 7345 485597 with message:\n"${orderNumber}"`, rightX, y + 14 + qrSize + 6, { width: qrSize });

  y = y + 14 + qrSize + 42;

  // WhatsApp clickable link
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text("WhatsApp link:", pageLeft, y);
  y += 12;
  doc.font("Helvetica").fontSize(9).fillColor("#1d4ed8").text(whatsappUrl, pageLeft, y, { width: pageWidth });
  doc.link(pageLeft, y - 2, pageWidth, 14, whatsappUrl);
  doc.fillColor("#0f172a");
  y += 22;

  // Landing fallback clickable
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text("Fallback link (driver page):", pageLeft, y);
  y += 12;
  doc.font("Helvetica").fontSize(9).fillColor("#1d4ed8").text(landingUrl, pageLeft, y, { width: pageWidth });
  doc.link(pageLeft, y - 2, pageWidth, 14, landingUrl);
  doc.fillColor("#0f172a");
  y += 22;

  // ---------- Remarks ----------
  y = sectionTitle("Remarks", y);
  doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(dRemarks, pageLeft, y, { width: pageWidth });
  doc.fillColor("#0f172a");

  // Footer
  doc.font("Helvetica").fontSize(8).fillColor("#94a3b8")
    .text(`Generated by Milestones Portal • Expires in: ${expiresInMinutes ?? "—"} minutes`, pageLeft, doc.page.height - 28, {
      width: pageWidth,
      align: "center"
    });

  doc.end();
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));