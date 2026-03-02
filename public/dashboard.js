function qs(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

const order = qs("order");
const orderPill = document.getElementById("orderPill");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

if (!order) {
  statusEl.textContent = "Missing ?order=";
  throw new Error("Missing order");
}
orderPill.textContent = `Order: ${order}`;

// Leaflet map
const map = L.map("map");
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

const layers = {
  pickup: null,
  delivery: null,
  pings: L.layerGroup().addTo(map),
  route: null
};

function addLog(line) {
  const div = document.createElement("div");
  div.textContent = line;
  logEl.prepend(div);
}

function safeLatLng(obj) {
  if (!obj) return null;
  const lat = Number(obj.lat);
  const lon = Number(obj.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lat, lon];
}

// Bootstrap existing events + infer coords from earliest pings (optional)
let pickupCoord = null;
let deliveryCoord = null;

function redrawRoute() {
  if (layers.route) {
    map.removeLayer(layers.route);
    layers.route = null;
  }
  const pts = [];
  if (pickupCoord) pts.push(pickupCoord);
  if (deliveryCoord) pts.push(deliveryCoord);
  if (pts.length >= 2) layers.route = L.polyline(pts).addTo(map);
}

// Connect SSE
const es = new EventSource(`/api/stream?order=${encodeURIComponent(order)}`);

es.addEventListener("open", () => {
  statusEl.textContent = "Connected ✅";
});

es.addEventListener("error", () => {
  statusEl.textContent = "Disconnected / retrying…";
});

es.addEventListener("bootstrap", (evt) => {
  const all = JSON.parse(evt.data || "[]");

  // show existing pings
  for (const e of all) {
    if (e.geo?.lat && e.geo?.lon) {
      const pt = [e.geo.lat, e.geo.lon];
      L.circleMarker(pt, { radius: 6 }).addTo(layers.pings)
        .bindPopup(`${e.milestoneType} @ ${e.receivedAtUtc}`);
    }
  }

  // center map on last ping if exists else world-ish
  const lastWithGeo = [...all].reverse().find(x => x.geo?.lat && x.geo?.lon);
  if (lastWithGeo) map.setView([lastWithGeo.geo.lat, lastWithGeo.geo.lon], 10);
  else map.setView([20, 0], 2);

  addLog(`Loaded ${all.length} existing events`);
});

// Normal events: default "message"
es.onmessage = (evt) => {
  const e = JSON.parse(evt.data);

  addLog(`${e.receivedAtUtc} — ${e.milestoneType}${e.delayReason ? " (" + e.delayReason + ")" : ""}`);

  // plot ping if geo present
  const pt = safeLatLng(e.geo);
  if (pt) {
    L.circleMarker(pt, { radius: 7 }).addTo(layers.pings)
      .bindPopup(`${e.milestoneType} @ ${e.receivedAtUtc}`)
      .openPopup();
    map.setView(pt, Math.max(map.getZoom(), 11));
  }
};