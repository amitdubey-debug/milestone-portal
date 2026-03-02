function qs(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

const token = qs("token");

// DOM
const sub = document.getElementById("sub");
const statusEl = document.getElementById("status");

const contextBox = document.getElementById("context");
const orderPill = document.getElementById("orderPill");
const locs = document.getElementById("locs");

const buttonsRow = document.getElementById("buttons");
const arrivedBtn = document.getElementById("arrivedBtn");
const departedBtn = document.getElementById("departedBtn");
const delayBtn = document.getElementById("delayBtn");

const delayFields = document.getElementById("delayFields");
const reasonSel = document.getElementById("reason");
const notesTxt = document.getElementById("notes");

const actions = document.getElementById("actions");
const submitBtn = document.getElementById("submitBtn");

let context = null;
let chosen = null;

function setStatus(msg, type = "muted") {
  statusEl.className = "status " + (type === "ok" ? "ok" : type === "err" ? "err" : "");
  statusEl.textContent = msg || "";
}

function select(type) {
  chosen = type;

  [arrivedBtn, departedBtn, delayBtn].forEach(b => b.classList.remove("selected"));
  if (type === "PICKED_UP") arrivedBtn.classList.add("selected");
  if (type === "DELIVERED") departedBtn.classList.add("selected");
  if (type === "DELAY") delayBtn.classList.add("selected");

  delayFields.style.display = type === "DELAY" ? "block" : "none";
  setStatus("");
}

async function fetchContext() {
  try {
    if (!token) throw new Error("Missing token in URL");

    const r = await fetch(`/api/context?token=${encodeURIComponent(token)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Failed to load context");

    context = data;

    // UI show
    sub.textContent = "Confirm your milestone update.";
    contextBox.style.display = "block";
    orderPill.textContent = `Order: ${context.orderNumber}`;
    locs.textContent = `Pick up: ${context.pickupLocation} • Delivery: ${context.deliveryLocation}`;

    arrivedBtn.textContent = `Pick up from ${context.pickupLocation}`;
    departedBtn.textContent = `Delivered at ${context.deliveryLocation}`;

    buttonsRow.style.display = "flex";
    actions.style.display = "flex";

    // default
    select("PICKED_UP");

    console.log("Context loaded:", context);
  } catch (e) {
    console.error("Context error:", e);
    sub.textContent = "Link expired or invalid.";
    setStatus(e.message, "err");
  }
}

function getGeo() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      }),
      (err) => {
        console.warn("Geolocation error:", err);
        resolve(null); // don’t block submit
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }
    );
  });
}

async function submit() {
  try {
    console.log("Submit clicked. chosen=", chosen);

    if (!context) {
      setStatus("Context not loaded yet.", "err");
      return;
    }
    if (!chosen) {
      setStatus("Please choose a milestone.", "err");
      return;
    }
    if (chosen === "DELAY" && !reasonSel.value) {
      setStatus("Please select a delay reason.", "err");
      return;
    }

    submitBtn.disabled = true;
    setStatus("Submitting… (requesting location)");

    const geo = await getGeo();
    console.log("Geo:", geo);

    const payload = {
      token,
      milestoneType: chosen,
      delayReason: chosen === "DELAY" ? reasonSel.value : undefined,
      delayNotes: chosen === "DELAY" ? notesTxt.value : undefined,
      geo
    };

    console.log("POST /api/submit payload:", payload);

    const r = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    console.log("Submit response:", r.status, data);

    if (!r.ok) throw new Error(data.error || "Submit failed");

    setStatus("Submitted successfully ✅ Thank you!", "ok");
  } catch (e) {
    console.error("Submit error:", e);
    setStatus(e.message, "err");
  } finally {
    submitBtn.disabled = false;
  }
}

// Bind handlers (IMPORTANT)
arrivedBtn.addEventListener("click", () => select("PICKED_UP"));
departedBtn.addEventListener("click", () => select("DELIVERED"));
delayBtn.addEventListener("click", () => select("DELAY"));
submitBtn.addEventListener("click", submit);

// Start
fetchContext();