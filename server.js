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
// ---------- PDF (FRO sample-matching layout: 2 pages, fixed boxes, side-by-side QRs) ----------
app.post("/api/pdf", async (req, res) => {
  const {
    orderNumber,
    pickupLocation,
    deliveryLocation,
    expiresInMinutes,
    token,

    // optional future fields
    bookingNumber,
    blNumber,
    customerName,
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
    bondedGoods,
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

  // Links
  const landingUrl = `${baseUrl}/s/${createShortCode(token)}`; // full driver page
  const pickupUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=PICKED_UP`;
  const deliveredUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELIVERED`;
  const delayUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELAY`;

  // WhatsApp QR
  const whatsappNumber = "447345485597"; // +44-7345485597
  const whatsappText = `Order ${orderNumber}`;
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(whatsappText)}`;

  // QR images (smaller, consistent)
  const driverQrPng = await QRCode.toBuffer(landingUrl, { width: 420, margin: 1 });
  const whatsappQrPng = await QRCode.toBuffer(whatsappUrl, { width: 420, margin: 1 });

  // Dummy-fill missing data to match sample
  const d = {
    dispatcher: "Dispatcher",
    dispatcherPhone: "",
    dispatcherEmail: "nl.execution@lns.maersk.com",
    systemDate: new Date().toLocaleString("en-GB").replace(",", ""),

    transportByName: "CONTARGO WOERTH GMBH",
    transportByStreet: "HAFENSTRASSE",
    transportByCity: "76744 Woerth a Rhein",
    transportByCountry: "Germany",

    bookingNumber: bookingNumber || String(orderNumber),
    blNumber: blNumber || String(orderNumber),
    customerName: customerName || "MERCEDES BENZ AG",
    workOrderNumber: String(orderNumber),
    forwardingOrderNumber: forwardingOrderNumber || "7003175564",

    transportMode: transportMode || "Truck",
    oceanCarrier: oceanCarrier || "MAEU / Maersk A/S",
    moveType: moveType || "Export",
    earliestPortReceiptDate: earliestPortReceiptDate || "14.02.2026 07:00:00",
    vesselCutoffDate: vesselCutoffDate || "28.02.2026 07:00:00",
    vesselDepartureDate: vesselDepartureDate || "02.03.2026 18:00:00",
    vesselVoyage: vesselVoyage || "MAREN MAERSK/608E",

    placeOfReceipt: placeOfReceipt || (pickupLocation || "Bremerhaven Port , UK"),
    portOfLoading: portOfLoading || "NLROT - APM 2 Terminal Maasvlakte II, Rotterdam, Netherlands",
    nextPort: nextPort || "Pelabuhan Tanjung Pelepas Terminal, Malaysia",
    portOfDischarge: portOfDischarge || "Tianjin PAC Intl Cntr Terminal, China",
    placeOfDelivery: placeOfDelivery || (deliveryLocation || "Hamburg DC"),

    equipmentType: equipmentType || `40 DRY 9'6"`,
    containerSeal: containerSeal || "TSK6018425",
    tareWeight: tareWeight || "3880 KG",
    totalWeight: totalWeight || "6308.6 KG",

    cargoDescription: cargoDescription || `Autoparts - Order ${orderNumber}`,
    packageDescription: packageDescription || "COLLI",
    packageQty: packageQty || "36",
    packageWeight: packageWeight || "2.428,6",
    packageUom: packageUom || "KGM",
    hsCode: hsCode || "870829",
    bondedGoods: bondedGoods || "No",

    stageFrom: stageFrom || (pickupLocation || "Bremerhaven Port , UK"),
    stageTo: stageTo || (deliveryLocation || "Hamburg DC"),
    appointmentFrom: appointmentFrom || "23.02.2026 07:00:00",
    appointmentTo: appointmentTo || "25.02.2026 14:21:35",

    totalCost: totalCost || "463,80 EUR",
    detailedCostLine1: detailedCostLine1 || "Barge 389,00 EUR",
    detailedCostLine2: detailedCostLine2 || "Intermodal Fuel Surcharge 74,80 EUR",

    remarks: remarks || "—"
  };

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

  const thin = () => doc.strokeColor("#000").lineWidth(0.6);
  const box = (x, y, w, h) => { thin(); doc.rect(x, y, w, h).stroke(); };
  const hline = (x1, y, x2) => { thin(); doc.moveTo(x1, y).lineTo(x2, y).stroke(); };

  const t = (s, x, y, size = 9, bold = false, opts = {}) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#000").text(String(s ?? ""), x, y, opts);
  };

  // Label + value like sample: label left, value bold (often right-aligned)
  const kv = (label, value, x, y, labelW, valueW, alignValueRight = false) => {
    t(label, x, y, 9, true, { width: labelW });
    t(
      value,
      x + labelW,
      y,
      9,
      false,
      { width: valueW, align: alignValueRight ? "right" : "left" }
    );
  };

  // ===================== PAGE 1 =====================
  // Dispatcher line
  t(
    `Dispatcher: ${d.dispatcher}     Dispatcher phone: ${d.dispatcherPhone}     Dispatcher email: ${d.dispatcherEmail}     System date: ${d.systemDate}`,
    L,
    18,
    8,
    false
  );

  // Logo placeholder (since we don’t have image file). If you add an image later, swap this.
  box(L, 52, 40, 40);
  t("MAERSK", L + 6, 67, 9, true);

  // Title centered
  t("Export Work Order", L, 60, 22, true, { width: W, align: "center" });
  t("Page 1 of 2", R - 90, 785, 9, false);

  // Transport By label + address box
  t("Transport By", L, 130, 9, true);
  const addrX = L + 90;
  const addrY = 120;
  const addrW = 280;
  const addrH = 70;
  box(addrX, addrY, addrW, addrH);
  t(d.transportByName, addrX + 10, addrY + 10, 10, true);
  t(d.transportByStreet, addrX + 10, addrY + 26, 9);
  t(d.transportByCity, addrX + 10, addrY + 40, 9);
  t(d.transportByCountry, addrX + 10, addrY + 54, 9);

  // Left small list (Booking/BL/Customer) like sample
  const leftListY = 200;
  kv("Booking Number", d.bookingNumber, L, leftListY, 140, 160, false);
  kv("B/L Number", d.blNumber, L, leftListY + 18, 140, 160, false);
  kv("Customer Name", d.customerName, L, leftListY + 36, 140, 200, false);

  // Right details list (WO/Fwd/Mode/Carrier/Move/Dates/Voyage/Places) like sample
  const rightColX = L + 330;
  const rightY = 140;
  const labelW = 170;
  const valueW = 210;

  kv("Work Order Number", d.workOrderNumber, rightColX, rightY, labelW, valueW, true);
  kv("Forwarding Order Number", d.forwardingOrderNumber, rightColX, rightY + 18, labelW, valueW, true);
  kv("Transport Mode", d.transportMode, rightColX, rightY + 36, labelW, valueW, true);
  kv("Ocean Carrier", d.oceanCarrier, rightColX, rightY + 54, labelW, valueW, true);
  kv("Move Type", d.moveType, rightColX, rightY + 72, labelW, valueW, true);
  kv("Earliest Port Receipt Date", d.earliestPortReceiptDate, rightColX, rightY + 90, labelW, valueW, true);
  kv("Vessel Cutoff Date", d.vesselCutoffDate, rightColX, rightY + 108, labelW, valueW, true);
  kv("Vessel Departure Date", d.vesselDepartureDate, rightColX, rightY + 126, labelW, valueW, true);
  kv("Vessel/Voyage", d.vesselVoyage, rightColX, rightY + 144, labelW, valueW, true);
  kv("Place of Receipt", d.placeOfReceipt, rightColX, rightY + 162, labelW, valueW, true);
  kv("Port of Loading", d.portOfLoading, rightColX, rightY + 180, labelW, valueW, true);
  kv("Next Port", d.nextPort, rightColX, rightY + 198, labelW, valueW, true);
  kv("Port of Discharge", d.portOfDischarge, rightColX, rightY + 216, labelW, valueW, true);
  kv("Place of Delivery", d.placeOfDelivery, rightColX, rightY + 234, labelW, valueW, true);

  // Equipment and Cargo Details header with lines (like sample)
  const eHeadY = 402;
  hline(L, eHeadY, R);
  t("Equipment and Cargo Details", L, eHeadY + 4, 11, true, { width: W, align: "center" });
  hline(L, eHeadY + 22, R);

  // Equipment table box
  const eqY = eHeadY + 28;
  const eqH = 72;
  box(L, eqY, W, eqH);

  // Column positions (match sample style)
  const c1 = L + 10;
  const c2 = L + 200;
  const c3 = L + 340;
  const c4 = L + 440;

  t("Equipment Type", c1, eqY + 8, 9, true);
  t("Container Seal", c2, eqY + 8, 9, true);
  t("Tare", c3, eqY + 8, 9, true);
  t("Total Weight", c4, eqY + 8, 9, true);
  hline(L, eqY + 24, R);

  t(d.equipmentType, c1, eqY + 34, 9);
  t(d.containerSeal, c2, eqY + 34, 9);
  t(d.tareWeight, c3, eqY + 34, 9);
  t(d.totalWeight, c4, eqY + 34, 9);

  // Cargo details block (like sample: cargo description row + table)
  const cargoY = eqY + eqH + 12;
  t("Cargo details", L, cargoY, 9, true);

  // Cargo description row
  const cdY = cargoY + 14;
  box(L, cdY, W, 26);
  t("Cargo Description:", L + 10, cdY + 7, 9, true);
  t(d.cargoDescription, L + 140, cdY + 7, 9);

  // Package table
  const pY = cdY + 26;
  const pH = 44;
  box(L, pY, W, pH);
  // vertical lines to mimic sample
  const v1 = L + 300;
  const v2 = L + 350;
  const v3 = L + 450;
  const v4 = L + 560;
  hline(L, pY + 20, R);
  thin(); doc.moveTo(v1, pY).lineTo(v1, pY + pH).stroke();
  thin(); doc.moveTo(v2, pY).lineTo(v2, pY + pH).stroke();
  thin(); doc.moveTo(v3, pY).lineTo(v3, pY + pH).stroke();
  thin(); doc.moveTo(v4, pY).lineTo(v4, pY + pH).stroke();

  t("Package Description", L + 10, pY + 5, 9, true);
  t("Package QTY", v1 + 8, pY + 5, 9, true);
  t("Weight", v2 + 8, pY + 5, 9, true);
  t("Unit of Measurement", v3 + 8, pY + 5, 9, true);
  t("HS Code", v4 + 8, pY + 5, 9, true);

  t(d.packageDescription, L + 120, pY + 26, 9);
  t(d.packageQty, v1 + 20, pY + 26, 9);
  t(d.packageWeight, v2 + 20, pY + 26, 9);
  t(d.packageUom, v3 + 40, pY + 26, 9);
  t(d.hsCode, v4 + 20, pY + 26, 9);

  // Bonded goods line
  t("Bonded Goods", L, pY + pH + 12, 9, false);
  t(d.bondedGoods, L + 120, pY + pH + 12, 9, false);

  // Stage table (like sample)
  const stY = pY + pH + 44;
  box(L, stY, W, 110);
  // header
  hline(L, stY + 22, R);
  t("Stage", L + 10, stY + 6, 9, true);
  t("From", L + 140, stY + 6, 9, true);
  t("To", L + 420, stY + 6, 9, true);

  // row content
  t("1", L + 16, stY + 32, 9, false);
  t(d.stageFrom, L + 140, stY + 32, 9, false, { width: 250 });
  t(d.stageTo, L + 420, stY + 32, 9, false, { width: 240 });

  t(`Appointment Arrival: ${d.appointmentFrom}`, L + 140, stY + 72, 9, false);
  t(`Appointment Arrival: ${d.appointmentTo}`, L + 420, stY + 72, 9, false);

  // Total cost
  t(`Total cost ${d.totalCost}`, L, stY + 128, 10, true);

  // ===================== PAGE 2 =====================
  doc.addPage();

  const L2 = doc.page.margins.left;
  const R2 = doc.page.width - doc.page.margins.right;
  const W2 = R2 - L2;

  // Header line + title
  t(
    `Dispatcher: ${d.dispatcher}     Dispatcher phone: ${d.dispatcherPhone}     Dispatcher email: ${d.dispatcherEmail}     System date: ${new Date().toLocaleString("en-GB").replace(",", "")}`,
    L2,
    18,
    8,
    false
  );
  t("Export Work Order", L2, 52, 26, true);
  t("Page 2 of 2", R2 - 90, 60, 9, false);

  // Detailed cost box
  t("Detailed Cost", L2, 110, 14, true);
  box(L2, 130, W2, 68);
  t(d.detailedCostLine1, L2 + 12, 146, 12, false);
  t(d.detailedCostLine2, L2 + 12, 168, 12, false);

  // Milestone update (Tap buttons) - FIXED so DELAY is not weird
  t("Milestone Update (Tap buttons)", L2, 220, 14, true);
  box(L2, 242, W2, 132);

  const mx = L2 + 14;
  const mw = W2 - 28;
  const mh = 30;

  // Each button box is a link
  const tap = (label, url, y) => {
    box(mx, y, mw, mh);
    doc.link(mx, y, mw, mh, url);
    t(label, mx + 10, y + 9, 12, true);
  };

  tap(`PICK UP (from ${pickupLocation || d.placeOfReceipt})`, pickupUrl, 254);
  tap(`DELIVERED (at ${deliveryLocation || d.placeOfDelivery})`, deliveredUrl, 290);
  tap("DELAY (reason page)", delayUrl, 326);

  // Note BELOW the box (no overlap)
  t("If location is blocked, event still submits (without GPS).", L2, 380, 9, false);

  // QR section with TWO QRs SIDE BY SIDE in a single boundary box
  t("Scan QR Codes", L2, 420, 14, true);
  box(L2, 442, W2, 290);

  const qrSize = 190;
  const qy = 480;
  const qx1 = L2 + 40;
  const qx2 = L2 + 320;

  // Labels
  t("Driver page", qx1, 456, 11, true);
  t("WhatsApp (share order)", qx2, 456, 11, true);

  doc.image(driverQrPng, qx1, qy, { fit: [qrSize, qrSize] });
  doc.image(whatsappQrPng, qx2, qy, { fit: [qrSize, qrSize] });

  t(`WhatsApp to +44 7345 485597 with: "Order ${orderNumber}"`, qx2, qy + qrSize + 14, 10, false);

  // Remarks
  t("Remarks", L2, 748, 14, true);
  box(L2, 770, W2, 44);
  t(d.remarks, L2 + 12, 782, 10, false, { width: W2 - 24 });

  doc.end();
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));