function qs(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

const order = qs("order");
const orderPill = document.getElementById("orderPill");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const rowsEl = document.getElementById("rows");
const refreshBtn = document.getElementById("refreshBtn");

if (!order) {
  statusEl.textContent = "Missing ?order=";
  throw new Error("Missing order");
}
orderPill.textContent = `Order: ${order}`;

const map = L.map("map");
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

const layers = {
  points: L.layerGroup().addTo(map),
  trail: null
};

const trailPts = [];
const MAX_TRAIL_POINTS = 1500; // safety cap

function safeLatLng(obj) {
  if (!obj) return null;
  const lat = Number(obj.lat);
  const lon = Number(obj.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lat, lon];
}

function clearUI() {
  rowsEl.innerHTML = "";
  layers.points.clearLayers();
  trailPts.length = 0;
  if (layers.trail) {
    map.removeLayer(layers.trail);
    layers.trail = null;
  }
}

function redrawTrail() {
  if (layers.trail) {
    map.removeLayer(layers.trail);
    layers.trail = null;
  }
  if (trailPts.length >= 2) {
    layers.trail = L.polyline(trailPts).addTo(map);
  }
}

function addRow(e) {
  const tr = document.createElement("tr");

  const tdTime = document.createElement("td");
  tdTime.className = "mono";
  tdTime.textContent = e.receivedAtUtc || "";

  const tdType = document.createElement("td");
  tdType.textContent = e.milestoneType || "";

  const tdDet = document.createElement("td");
  const parts = [];
  if (e.milestoneType === "GPS_PING" && e.pingSource) parts.push(`Source: ${e.pingSource}`);
  if (e.delayReason) parts.push(`Reason: ${e.delayReason}`);
  if (e.delayNotes) parts.push(`Notes: ${e.delayNotes}`);
  tdDet.textContent = parts.join(" • ") || "";

  const tdGeo = document.createElement("td");
  if (e.geo?.lat && e.geo?.lon) {
    tdGeo.className = "mono";
    tdGeo.textContent =
      `${Number(e.geo.lat).toFixed(5)}, ${Number(e.geo.lon).toFixed(5)}${e.geo.accuracy ? ` (±${Math.round(e.geo.accuracy)}m)` : ""}`;
  } else {
    tdGeo.textContent = "";
  }

  tr.appendChild(tdTime);
  tr.appendChild(tdType);
  tr.appendChild(tdDet);
  tr.appendChild(tdGeo);
  rowsEl.appendChild(tr);
}

function addMapPoint(e) {
  const pt = safeLatLng(e.geo);
  if (!pt) return;

  trailPts.push(pt);
  if (trailPts.length > MAX_TRAIL_POINTS) trailPts.shift();
  redrawTrail();

  const label =
    `${e.milestoneType} @ ${e.receivedAtUtc}` +
    (e.pingSource ? ` (${e.pingSource})` : "") +
    (e.delayReason ? ` (${e.delayReason})` : "");

  const radius = e.milestoneType === "GPS_PING" ? 4 : 7;
  L.circleMarker(pt, { radius }).addTo(layers.points).bindPopup(label);

  map.setView(pt, Math.max(map.getZoom(), 11));
}

function renderAll(all) {
  clearUI();
  all.sort((a, b) => String(a.receivedAtUtc).localeCompare(String(b.receivedAtUtc)));

  for (const e of all) {
    addRow(e);
    if (safeLatLng(e.geo)) addMapPoint(e);
  }

  summaryEl.textContent = `Loaded ${all.length} events`;
  const lastWithGeo = [...all].reverse().find(x => x.geo?.lat && x.geo?.lon);
  if (lastWithGeo) map.setView([lastWithGeo.geo.lat, lastWithGeo.geo.lon], 10);
  else map.setView([20, 0], 2);
}

refreshBtn.addEventListener("click", async () => {
  summaryEl.textContent = "Refreshing…";
  try {
    const r = await fetch(`/api/milestones?order=${encodeURIComponent(order)}`);
    const all = await r.json();
    renderAll(all);
  } catch {
    summaryEl.textContent = "Refresh failed";
  }
});

// SSE
const es = new EventSource(`/api/stream?order=${encodeURIComponent(order)}`);

es.addEventListener("open", () => { statusEl.textContent = "Connected ✅"; });
es.addEventListener("error", () => { statusEl.textContent = "Disconnected / retrying…"; });

es.addEventListener("bootstrap", (evt) => {
  const all = JSON.parse(evt.data || "[]");
  renderAll(all);
});

es.onmessage = (evt) => {
  const e = JSON.parse(evt.data);
  addRow(e);
  addMapPoint(e);
  summaryEl.textContent = `Loaded ${rowsEl.children.length} events`;
};