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
// ---------- PDF (sample-like layout: clean Page-1, fixed Page-2, no overlap on delay) ----------
app.post("/api/pdf", async (req, res) => {
  const {
    orderNumber,
    pickupLocation,
    deliveryLocation,
    expiresInMinutes,
    token,

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
  const landingUrl = `${baseUrl}/s/${createShortCode(token)}`;
  const pickupUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=PICKED_UP`;
  const deliveredUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELIVERED`;
  const delayUrl = `${baseUrl}/s/${createShortCode(token)}?mode=quick&type=DELAY`;

  // WhatsApp QR
  const whatsappNumber = "447345485597"; // +44-7345485597 -> digits only
  const whatsappText = `Order ${orderNumber}`;
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(whatsappText)}`;

  const driverQrPng = await QRCode.toBuffer(landingUrl, { width: 420, margin: 1 });
  const whatsappQrPng = await QRCode.toBuffer(whatsappUrl, { width: 420, margin: 1 });

  // Dummy defaults (like sample)
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

    placeOfReceipt: placeOfReceipt || (pickupLocation || "Woerth a Rhein, Rhineland Palatinate, Germany"),
    portOfLoading: portOfLoading || "NLROT - APM 2 Terminal Maasvlakte II, Rotterdam, Netherlands",
    nextPort: nextPort || "Pelabuhan Tanjung Pelepas Terminal, Malaysia",
    portOfDischarge: portOfDischarge || "Tianjin PAC Intl Cntr Terminal, China",
    placeOfDelivery: placeOfDelivery || (deliveryLocation || "Xingang, Tianjin, China"),

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

    stageFrom: stageFrom || (pickupLocation || "Contargo Woerth / HAFENSTR. 1 / Woerth a Rhein / DE"),
    stageTo: stageTo || (deliveryLocation || "APM 2 Terminal Maasvlakte II / Europaweg 910 / Rotterdam / NL"),
    appointmentFrom: appointmentFrom || "23.02.2026 07:00:00",
    appointmentTo: appointmentTo || "25.02.2026 14:21:35",

    totalCost: totalCost || "463,80 EUR",
    detailedCostLine1: detailedCostLine1 || "Barge 389,00 EUR",
    detailedCostLine2: detailedCostLine2 || "Intermodal Fuel Surcharge 74,80 EUR",
    remarks: remarks || "—"
  };

  // Response headers
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
  const hline = (y) => { thin(); doc.moveTo(L, y).lineTo(R, y).stroke(); };

  const txt = (s, x, y, size = 9, bold = false, opts = {}) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#000")
      .text(String(s ?? ""), x, y, opts);
  };

const row = (label, value, xLabel, xValue, y) => {
  const valueWidth = (R - 10) - xValue; // always stay inside page
  txt(label, xLabel, y, 9, true, { width: xValue - xLabel - 8 });
  txt(value, xValue, y, 9, false, { width: valueWidth, ellipsis: true });
};

  // ===================== PAGE 1 =====================
  // top dispatcher line
  txt(
    `Dispatcher: ${d.dispatcher}        Dispatcher phone: ${d.dispatcherPhone}        Dispatcher email: ${d.dispatcherEmail}        System date: ${d.systemDate}`,
    L,
    18,
    8,
    false
  );

  // logo placeholder + title centered (sample has logo left, title centered)
  box(L + 6, 60, 26, 26);
  txt("M", L + 15, 66, 14, true);
  txt("Export Work Order", L, 62, 22, true, { width: W, align: "center" });

  // Left section positions (match sample layout)
  const xLabelL = L + 70;
  const xValueL = L + 220;

  // Right section positions
const xLabelR = L + 340;   // move label column slightly left
const xValueR = L + 500;   // move value column left (this is the big fix)

  // Transport by block (left)
  txt("Transport By", xLabelL, 210, 9, true);
  txt(d.transportByName, xValueL, 200, 9, true);
  txt(d.transportByStreet, xValueL, 214, 9, false);
  txt(d.transportByCity, xValueL, 228, 9, false);
  txt(d.transportByCountry, xValueL, 242, 9, false);

  // Booking / BL / Customer (left list)
  row("Booking Number", d.bookingNumber, xLabelL, xValueL, 270, 260);
  row("B/L Number", d.blNumber, xLabelL, xValueL, 288, 260);
  row("Customer Name", d.customerName, xLabelL, xValueL, 306, 260);

  // Right list (like sample)
  row("Work Order Number", d.workOrderNumber, xLabelR, xValueR, 200);
  row("Forwarding Order Number", d.forwardingOrderNumber, xLabelR, xValueR, 218, 220);

  row("Transport Mode", d.transportMode, xLabelR, xValueR, 246, 220);
  row("Ocean Carrier", d.oceanCarrier, xLabelR, xValueR, 264, 220);
  row("Move Type", d.moveType, xLabelR, xValueR, 282, 220);

  row("Earliest Port Receipt Date", d.earliestPortReceiptDate, xLabelR, xValueR, 310, 220);
  row("Vessel Cutoff Date", d.vesselCutoffDate, xLabelR, xValueR, 328, 220);
  row("Vessel Departure Date", d.vesselDepartureDate, xLabelR, xValueR, 346, 220);
  row("Vessel/Voyage", d.vesselVoyage, xLabelR, xValueR, 364, 220);

  row("Place of Receipt", d.placeOfReceipt, xLabelR, xValueR, 392, 220);
  row("Port of Loading", d.portOfLoading, xLabelR, xValueR, 410, 220);
  row("Next Port", d.nextPort, xLabelR, xValueR, 428, 220);
  row("Port of Discharge", d.portOfDischarge, xLabelR, xValueR, 446, 220);
  row("Place of Delivery", d.placeOfDelivery, xLabelR, xValueR, 464, 220);

  // Equipment & Cargo header with lines (sample)
  hline(510);
  txt("Equipment and Cargo Details", L, 516, 11, true, { width: W, align: "center" });
  hline(534);

  // Equipment table (sample style)
  const eqTop = 548;
  txt("Equipment Type", L + 30, eqTop, 9, true);
  txt("Container", L + 220, eqTop, 9, true);
  txt("Seal", L + 320, eqTop, 9, true);
  txt("Tare", L + 420, eqTop, 9, true);
  txt("Total Weight", L + 500, eqTop, 9, true);

  txt(d.equipmentType, L + 30, eqTop + 18, 9, false);
  txt("", L + 220, eqTop + 18, 9, false);
  txt(d.containerSeal, L + 320, eqTop + 18, 9, false);
  txt(d.tareWeight, L + 420, eqTop + 18, 9, false);
  txt(d.totalWeight, L + 500, eqTop + 18, 9, false);

  // Cargo details block with borders like sample
  txt("Cargo details", L + 12, 598, 9, true);

  // Cargo description row (border)
  box(L + 10, 614, W - 20, 22);
  txt("Cargo Description:", L + 18, 620, 9, true);
  txt(d.cargoDescription, L + 150, 620, 9, false);

  // Package header table (bordered)
  box(L + 10, 636, W - 20, 52);
  thin(); doc.moveTo(L + 10, 656).lineTo(R - 10, 656).stroke();

  // vertical lines
  const v1 = L + 290, v2 = L + 350, v3 = L + 450, v4 = L + 560;
  thin(); doc.moveTo(v1, 636).lineTo(v1, 688).stroke();
  thin(); doc.moveTo(v2, 636).lineTo(v2, 688).stroke();
  thin(); doc.moveTo(v3, 636).lineTo(v3, 688).stroke();
  thin(); doc.moveTo(v4, 636).lineTo(v4, 688).stroke();

  txt("Package Description", L + 20, 642, 9, true);
  txt("Package QTY", v1 + 10, 642, 9, true);
  txt("Weight", v2 + 10, 642, 9, true);
  txt("Unit of\nMeasurement", v3 + 10, 640, 9, true);
  txt("HS Code", v4 + 10, 642, 9, true);

  txt(d.packageDescription, L + 140, 664, 9, false);
  txt(d.packageQty, v1 + 20, 664, 9, false);
  txt(d.packageWeight, v2 + 20, 664, 9, false);
  txt(d.packageUom, v3 + 40, 664, 9, false);
  txt(d.hsCode, v4 + 20, 664, 9, false);

  txt("Bonded Goods", L + 12, 704, 9, false);
  txt(d.bondedGoods, L + 130, 704, 9, false);

  // Stage table (bordered) like sample
const stTop = 680;                 // move up
box(L + 10, stTop, W - 20, 74);    // slightly smaller
  thin(); doc.moveTo(L + 10, stTop + 22).lineTo(R - 10, stTop + 22).stroke();

  txt("Stage", L + 20, stTop + 6, 9, true);
  txt("From", L + 160, stTop + 6, 9, true);
  txt("To", L + 430, stTop + 6, 9, true);

txt("1", L + 24, stTop + 28, 9, true);
txt(d.stageFrom, L + 160, stTop + 28, 9, false, { width: 240 });
txt(d.stageTo, L + 430, stTop + 28, 9, false, { width: 240 });

txt(`Appointment Arrival: ${d.appointmentFrom}`, L + 160, stTop + 50, 9, false);
txt(`Appointment Arrival: ${d.appointmentTo}`, L + 430, stTop + 50, 9, false);

  txt(`Total cost ${d.totalCost}`, L + 10, 770, 10, true);
txt("Page 1 of 2", R - 90, 770, 9, false);

  // ===================== PAGE 2 =====================
  doc.addPage();

  const L2 = doc.page.margins.left;
  const R2 = doc.page.width - doc.page.margins.right;
  const W2 = R2 - L2;

  const box2 = (x, y, w, h) => { doc.strokeColor("#000").lineWidth(0.6); doc.rect(x, y, w, h).stroke(); };
  const txt2 = (s, x, y, size = 9, bold = false, opts = {}) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#000")
      .text(String(s ?? ""), x, y, opts);
  };

  txt2(
    `Dispatcher: ${d.dispatcher}        Dispatcher phone: ${d.dispatcherPhone}        Dispatcher email: ${d.dispatcherEmail}        System date: ${new Date().toLocaleString("en-GB").replace(",", "")}`,
    L2,
    18,
    8,
    false
  );
  txt2("Export Work Order", L2, 52, 26, true);
  txt2("Page 2 of 2", R2 - 90, 60, 9, false);

  // Detailed cost
  txt2("Detailed Cost", L2, 110, 14, true);
  box2(L2, 130, W2, 68);
  txt2(d.detailedCostLine1, L2 + 16, 146, 12, false);
  txt2(d.detailedCostLine2, L2 + 16, 168, 12, false);

  // Milestone Update
  txt2("Milestone Update (Tap buttons)", L2, 220, 14, true);
  box2(L2, 242, W2, 132);

  const mx = L2 + 14;
  const mw = W2 - 28;
  const mh = 30;

  const tap = (label, url, y) => {
    box2(mx, y, mw, mh);
    doc.link(mx, y, mw, mh, url);
    txt2(label, mx + 10, y + 8, 12, true);
  };

  tap(`PICK UP (from ${pickupLocation || d.placeOfReceipt})`, pickupUrl, 254);
  tap(`DELIVERED (at ${deliveryLocation || d.placeOfDelivery})`, deliveredUrl, 290);
  tap("DELAY (reason page)", delayUrl, 326);

  // ✅ FIX: note goes OUTSIDE the box (no overlap)
  txt2("If location is blocked, event still submits (without GPS).", L2, 380, 9, false);

  // QRs side-by-side inside one boundary
  txt2("Scan QR Codes", L2, 420, 14, true);
  box2(L2, 442, W2, 290);

  const qrSize = 190;
  const qy = 480;
  const qx1 = L2 + 40;
  const qx2 = L2 + 320;

  txt2("Driver page", qx1, 456, 11, true);
  txt2("WhatsApp (share order)", qx2, 456, 11, true);

  doc.image(driverQrPng, qx1, qy, { fit: [qrSize, qrSize] });
  doc.image(whatsappQrPng, qx2, qy, { fit: [qrSize, qrSize] });

  txt2(`WhatsApp to +44 7345 485597 with: "Order ${orderNumber}"`, qx2, qy + qrSize + 14, 10, false);

  // Remarks
  txt2("Remarks", L2, 748, 14, true);
  box2(L2, 770, W2, 44);
  txt2(d.remarks, L2 + 12, 782, 10, false, { width: W2 - 24 });

  doc.end();
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));