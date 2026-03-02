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
// ---------- PDF (FRO-style, 2 pages, bounded layout) ----------
app.post("/api/pdf", async (req, res) => {
  const {
    orderNumber,
    pickupLocation,
    deliveryLocation,
    expiresInMinutes,
    token,

    // Optional fields if you ever add them later (safe if missing)
    dispatcher,
    dispatcherPhone,
    dispatcherEmail,
    systemDate,

    transportByName,
    transportByStreet,
    transportByPostalCity,
    transportByCountry,

    bookingNumber,
    blNumber,
    customerName,
    workOrderNumber,
    forwardingOrderNumber,
    transportMode,
    oceanCarrier,
    moveType,

    earliestPortReceiptDate,
    vesselCutoffDate,
    vesselDepartureDate,
    vesselVoyage,

    placeOfReceipt,
    portOfLoading,
    nextPort,
    portOfDischarge,
    placeOfDelivery,

    equipmentType,
    containerSeal,
    tareWeight,
    totalWeight,

    cargoDescription,
    packageDescription,
    packageQty,
    packageWeight,
    packageUom,
    hsCode,
    bondedGoodsNo,

    stageFrom,
    stageTo,
    appointmentFrom,
    appointmentTo,

    totalCost,
    detailedCostLine1,
    detailedCostLine2,

    remarks
  } = req.body || {};

  if (!orderNumber || !token) {
    return res.status(400).json({ error: "Missing required fields for PDF: orderNumber, token" });
  }

  const baseUrl = baseUrlFromReq(req);

  // Landing page (full UI)
  const landingUrl = `${baseUrl}/s/${createShortCode(token)}`;

  // PDF “tap to submit” buttons -> quick page
  const pickupUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=PICKED_UP`;
  const deliveredUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELIVERED`;
  const delayUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELAY`;

  // WhatsApp QR
  const whatsappNumber = "447345485597"; // +44-7345485597 digits only
  const whatsappText = `Order ${orderNumber}`;
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(whatsappText)}`;

  // QRs (keep small enough so they never cause new pages)
  const driverQrPng = await QRCode.toBuffer(landingUrl, { width: 360, margin: 1 });
  const whatsappQrPng = await QRCode.toBuffer(whatsappUrl, { width: 360, margin: 1 });

  // ---------- Dummy placeholders (match sample fields) ----------
  const d = {
    dispatcher: dispatcher || "Dispatcher",
    dispatcherPhone: dispatcherPhone || "Dispatcher phone:",
    dispatcherEmail: dispatcherEmail || "nl.execution@lns.maersk.com",
    systemDate: systemDate || new Date().toLocaleString("en-GB").replace(",", ""),

    transportByName: transportByName || "CONTARGO WOERTH GMBH",
    transportByStreet: transportByStreet || "HAFENSTRASSE",
    transportByPostalCity: transportByPostalCity || "76744 Woerth a Rhein",
    transportByCountry: transportByCountry || "Germany",

    bookingNumber: bookingNumber || String(orderNumber),
    blNumber: blNumber || String(orderNumber),
    customerName: customerName || "MERCEDES BENZ AG",
    workOrderNumber: workOrderNumber || String(orderNumber),
    forwardingOrderNumber: forwardingOrderNumber || "7003175564",
    transportMode: transportMode || "Truck",
    oceanCarrier: oceanCarrier || "MAEU / Maersk A/S",
    moveType: moveType || "Export",

    earliestPortReceiptDate: earliestPortReceiptDate || "14.02.2026 07:00:00",
    vesselCutoffDate: vesselCutoffDate || "28.02.2026 07:00:00",
    vesselDepartureDate: vesselDepartureDate || "02.03.2026 18:00:00",
    vesselVoyage: vesselVoyage || "MAREN MAERSK/608E",

    placeOfReceipt: placeOfReceipt || (pickupLocation || "Woerth a Rhein, Germany"),
    portOfLoading: portOfLoading || "NLROT - APM 2 Terminal Maasvlakte II, Rotterdam, Netherlands",
    nextPort: nextPort || "Pelabuhan Tanjung Pelepas Terminal, Malaysia",
    portOfDischarge: portOfDischarge || "Tianjin PAC Intl Cntr Terminal, China",
    placeOfDelivery: placeOfDelivery || (deliveryLocation || "Xingang, Tianjin, China"),

    equipmentType: equipmentType || "40 DRY 9'6\"",
    containerSeal: containerSeal || "TSK6018425",
    tareWeight: tareWeight || "3880 KG",
    totalWeight: totalWeight || "6308.6 KG",

    cargoDescription: cargoDescription || `Autoparts - Order ${orderNumber}`,
    packageDescription: packageDescription || "COLLI",
    packageQty: packageQty || "36",
    packageWeight: packageWeight || "2.428,6",
    packageUom: packageUom || "KGM",
    hsCode: hsCode || "870829",
    bondedGoodsNo: bondedGoodsNo || "—",

    stageFrom: stageFrom || (pickupLocation || "Contargo Woerth / HAFENSTR. 1 / Woerth a Rhein / DE"),
    stageTo: stageTo || (deliveryLocation || "APM 2 Terminal Maasvlakte II / Europaweg 910 / Rotterdam / NL"),
    appointmentFrom: appointmentFrom || "23.02.2026 07:00:00",
    appointmentTo: appointmentTo || "25.02.2026 14:21:35",

    totalCost: totalCost || "463,80 EUR",
    detailedCostLine1: detailedCostLine1 || "Barge 389,00 EUR",
    detailedCostLine2: detailedCostLine2 || "Intermodal Fuel Surcharge 74,80 EUR",

    remarks: remarks || `Haulage Instructions: Keep this PDF. Use buttons for quick updates.\nOrder: ${orderNumber}\n`
  };

  // ---------- PDF response headers ----------
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="FRO_${String(orderNumber).replace(/[^a-zA-Z0-9_-]/g, "")}.pdf"`
  );

  const doc = new PDFDocument({ size: "A4", margin: 28 });
  doc.pipe(res);

  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;

  const thin = () => { doc.strokeColor("#000").lineWidth(0.6); };
  const box = (x, y, w, h) => { thin(); doc.rect(x, y, w, h).stroke(); };
  const text = (s, x, y, size = 9, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#000").text(String(s ?? ""), x, y, { width: W });
  };

  const kvRow = (label, value, x, y) => {
    doc.font("Helvetica").fontSize(9).text(label, x, y, { continued: true });
    doc.font("Helvetica-Bold").fontSize(9).text(String(value ?? ""), x + 140, y);
  };

  // ===================== PAGE 1 =====================
  // Header line like sample
  text(`Dispatcher: ${d.dispatcher}    ${d.dispatcherPhone}    Dispatcher email: ${d.dispatcherEmail}    System date: ${d.systemDate}`, L, 18, 8, false);

  text("Export Work Order", L, 34, 18, true);
  text("Page 1 of 2", R - 80, 40, 9, false);

  // Transport By (address block)
  const addrY = 66;
  box(L, addrY, W * 0.55, 70);
  text(d.transportByName, L + 8, addrY + 8, 10, true);
  text(d.transportByStreet, L + 8, addrY + 24, 9, false);
  text(d.transportByPostalCity, L + 8, addrY + 38, 9, false);
  text(d.transportByCountry, L + 8, addrY + 52, 9, false);
  text("Transport By", L, addrY - 14, 9, true);

  // Right block: booking/customer/etc
  const rightX = L + W * 0.57;
  const rightW = W - (rightX - L);
  box(rightX, addrY, rightW, 70);

  let ry = addrY + 8;
  kvRow("Booking Number", d.bookingNumber, rightX + 8, ry); ry += 12;
  kvRow("B/L Number", d.blNumber, rightX + 8, ry); ry += 12;
  kvRow("Customer Name", d.customerName, rightX + 8, ry); ry += 12;
  kvRow("Work Order Number", d.workOrderNumber, rightX + 8, ry); ry += 12;
  kvRow("Forwarding Order No.", d.forwardingOrderNumber, rightX + 8, ry);

  // Details block
  const detY = addrY + 82;
  box(L, detY, W, 92);

  let dy = detY + 8;
  kvRow("Transport Mode", d.transportMode, L + 8, dy); dy += 12;
  kvRow("Ocean Carrier", d.oceanCarrier, L + 8, dy); dy += 12;
  kvRow("Move Type", d.moveType, L + 8, dy); dy += 12;
  kvRow("Earliest Port Receipt", d.earliestPortReceiptDate, L + 8, dy); dy += 12;
  kvRow("Vessel Cutoff Date", d.vesselCutoffDate, L + 8, dy); dy += 12;
  kvRow("Vessel Departure Date", d.vesselDepartureDate, L + 8, dy); dy += 12;
  kvRow("Vessel/Voyage", d.vesselVoyage, L + 8, dy);

  // Places block
  const plcY = detY + 106;
  box(L, plcY, W, 78);

  let py = plcY + 8;
  kvRow("Place of Receipt", d.placeOfReceipt, L + 8, py); py += 12;
  kvRow("Port of Loading", d.portOfLoading, L + 8, py); py += 12;
  kvRow("Next Port", d.nextPort, L + 8, py); py += 12;
  kvRow("Port of Discharge", d.portOfDischarge, L + 8, py); py += 12;
  kvRow("Place of Delivery", d.placeOfDelivery, L + 8, py);

  // Equipment and Cargo Details block
  const eqY = plcY + 92;
  text("Equipment and Cargo Details", L, eqY - 14, 9, true);
  box(L, eqY, W, 86);

  // Table header
  text("Equipment Type", L + 8, eqY + 8, 9, true);
  text("Container Seal", L + 170, eqY + 8, 9, true);
  text("Tare", L + 330, eqY + 8, 9, true);
  text("Total Weight", L + 410, eqY + 8, 9, true);
  thin();
  doc.moveTo(L + 8, eqY + 22).lineTo(R - 8, eqY + 22).stroke();

  // Row
  text(d.equipmentType, L + 8, eqY + 30, 9, false);
  text(d.containerSeal, L + 170, eqY + 30, 9, false);
  text(d.tareWeight, L + 330, eqY + 30, 9, false);
  text(d.totalWeight, L + 410, eqY + 30, 9, false);

  // Cargo details
  text("Cargo details", L + 8, eqY + 48, 9, true);
  text(`Cargo Description: ${d.cargoDescription}`, L + 8, eqY + 60, 9, false);

  // Stage block
  const stY = eqY + 102;
  text("Stage", L, stY - 14, 9, true);
  box(L, stY, W, 118);

  // Stage header
  text("From", L + 38, stY + 8, 9, true);
  text("To", L + W * 0.52, stY + 8, 9, true);
  thin();
  doc.moveTo(L + 8, stY + 22).lineTo(R - 8, stY + 22).stroke();

  // Stage row content
  text("1", L + 12, stY + 30, 9, true);
  text(d.stageFrom, L + 38, stY + 30, 8, false);
  text(d.stageTo, L + W * 0.52, stY + 30, 8, false);

  text(`Appointment Arrival: ${d.appointmentFrom}`, L + 38, stY + 72, 8, false);
  text(`Appointment Arrival: ${d.appointmentTo}`, L + W * 0.52, stY + 72, 8, false);

  // Total cost (bottom)
  text(`Total cost  ${d.totalCost}`, R - 160, 790, 10, true);

  // ===================== PAGE 2 =====================
  doc.addPage();

  const L2 = doc.page.margins.left;
  const R2 = doc.page.width - doc.page.margins.right;
  const W2 = R2 - L2;

  text(`Dispatcher: ${d.dispatcher}    ${d.dispatcherPhone}    Dispatcher email: ${d.dispatcherEmail}    System date: ${d.systemDate}`, L2, 18, 8, false);
  text("Export Work Order", L2, 34, 18, true);
  text("Page 2 of 2", R2 - 80, 40, 9, false);

  // Detailed cost
  text("Detailed Cost", L2, 72, 11, true);
  box(L2, 88, W2, 54);
  text(d.detailedCostLine1, L2 + 10, 98, 10, false);
  text(d.detailedCostLine2, L2 + 10, 114, 10, false);

  // Milestone update section (PDF tap links)
  text("Milestone Update (Tap buttons)", L2, 156, 11, true);
  box(L2, 172, W2, 108);

  // clickable link areas
  const linkH = 24;
  const linkW = W2 - 20;
  const lx = L2 + 10;

  const drawTap = (title, url, y) => {
    box(lx, y, linkW, linkH);
    doc.link(lx, y, linkW, linkH, url);
    text(title, lx + 8, y + 6, 10, true);
  };

  drawTap(`PICK UP (from ${pickupLocation || "pickup"})`, pickupUrl, 182);
  drawTap(`DELIVERED (at ${deliveryLocation || "delivery"})`, deliveredUrl, 182 + 28);
  drawTap("DELAY (reason page)", delayUrl, 182 + 56);

  text("If location is blocked, event still submits (without GPS).", L2 + 12, 250, 8, false);

  // QR section side-by-side (STRICT fixed area)
  text("Scan QR Codes", L2, 290, 11, true);
  box(L2, 306, W2, 210);

  const qrBoxSize = 160;
  const qy = 326;
  const qx1 = L2 + 18;
  const qx2 = L2 + 18 + qrBoxSize + 40;

  text("Driver page", qx1, 310, 9, true);
  doc.image(driverQrPng, qx1, qy, { fit: [qrBoxSize, qrBoxSize] });

  text("WhatsApp (share order)", qx2, 310, 9, true);
  doc.image(whatsappQrPng, qx2, qy, { fit: [qrBoxSize, qrBoxSize] });

  text(`WhatsApp to +44 7345 485597 with: "Order ${orderNumber}"`, qx2, qy + qrBoxSize + 6, 8, false);

  // IMPORTANT: do NOT print long URLs (prevents overflow / extra pages)
  text("Tip: QR is best on mobile. If needed, ask dispatcher for the driver link.", L2 + 18, 520, 8, false);

  // Remarks + disclaimer (like sample)
  text("Remarks", L2, 548, 11, true);
  box(L2, 564, W2, 80);
  text(d.remarks, L2 + 10, 574, 9, false);

  const disclaimer =
    "The information contained in this document is privileged and intended only for the recipients named. " +
    "If you have received it in error, please notify the sender and delete it.\n\n" +
    "Maersk will as part of our communication and interaction with you collect and process your personal data. " +
    "Please consider the environment before printing. If printed, please destroy the document after Transport Order is fulfilled.";

  box(L2, 656, W2, 140);
  text(disclaimer, L2 + 10, 666, 8, false);

  // Footer
  text(`Generated by Milestones Portal • Expires in: ${expiresInMinutes ?? "—"} minutes`, L2, 805, 8, false);

  doc.end();
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));