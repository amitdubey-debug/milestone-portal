const ids = (x) => document.getElementById(x);

const out = ids("out");
const genBtn = ids("genBtn");
const pdfBtn = ids("pdfBtn");
const qrWrap = ids("qrWrap");
const qrImg = ids("qrImg");

let last = null;
let lastShort = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      ta.remove();
      return false;
    }
  }
}

async function downloadPdf() {
  if (!last) return;

  pdfBtn.disabled = true;
  pdfBtn.textContent = "Preparing PDF…";

  try {
    const r = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(last)
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || "Failed to generate PDF");
    }

    const blob = await r.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `milestone-qr-${last.orderNumber}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    out.style.display = "block";
    out.innerHTML = `<span style="color:#c22"><b>Error:</b> ${escapeHtml(e.message)}</span>`;
  } finally {
    pdfBtn.disabled = false;
    pdfBtn.textContent = "Download PDF (with QR)";
  }
}

pdfBtn.addEventListener("click", downloadPdf);

genBtn.addEventListener("click", async () => {
  out.style.display = "none";
  out.innerHTML = "";
  qrWrap.style.display = "none";
  pdfBtn.style.display = "none";
  last = null;
  lastShort = null;

  const payload = {
    orderNumber: ids("orderNumber").value.trim(),
    pickupLocation: ids("pickupLocation").value.trim(),
    deliveryLocation: ids("deliveryLocation").value.trim(),
    ttlMinutes: ids("ttlMinutes").value.trim()
  };

  try {
    const r = await fetch("/api/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Failed");

    lastShort = data.shortLanding;

    out.style.display = "block";
    out.innerHTML = `
      <div><b>Driver landing (short):</b></div>
      <div class="copyRow">
        <a class="mono" href="${data.shortLanding}" target="_blank">${escapeHtml(data.shortLanding)}</a>
        <button class="small secondary" id="copyBtn">Copy</button>
      </div>

      <div style="margin-top:10px"><b>Milestone link (full):</b> <a href="${data.link}" target="_blank">${escapeHtml(data.link)}</a></div>
      <div style="margin-top:6px"><b>Live dashboard:</b> <a href="${data.dashboard}" target="_blank">${escapeHtml(data.dashboard)}</a></div>
      <div style="margin-top:6px" class="muted">Token expires in ${data.expiresInMinutes} minutes</div>
    `;

    const copyBtn = document.getElementById("copyBtn");
    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(lastShort);
      copyBtn.textContent = ok ? "Copied ✅" : "Copy failed";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    });

    qrImg.src = data.qrDataUrl; // QR opens landing (all updates)
    qrWrap.style.display = "block";

    last = {
      orderNumber: payload.orderNumber,
      pickupLocation: payload.pickupLocation,
      deliveryLocation: payload.deliveryLocation,
      expiresInMinutes: data.expiresInMinutes,
      token: data.token
    };

    pdfBtn.style.display = "inline-block";
  } catch (e) {
    out.style.display = "block";
    out.innerHTML = `<span style="color:#c22"><b>Error:</b> ${escapeHtml(e.message)}</span>`;
  }
});