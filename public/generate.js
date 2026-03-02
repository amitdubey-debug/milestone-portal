const ids = (x) => document.getElementById(x);

const out = ids("out");
const genBtn = ids("genBtn");
const pdfBtn = ids("pdfBtn");
const qrWrap = ids("qrWrap");
const qrImg = ids("qrImg");

let lastGenerated = null; // stored for PDF

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function renderQr(link) {
  // QRCode from CDN script in generate.html
  const dataUrl = await QRCode.toDataURL(link, {
    width: 340,
    margin: 1,
    errorCorrectionLevel: "M"
  });
  qrImg.src = dataUrl;
  qrWrap.style.display = "block";
  return dataUrl;
}

function drawDivider(doc, x, y, w) {
  doc.setDrawColor(220);
  doc.setLineWidth(1);
  doc.line(x, y, x + w, y);
}

function drawButtonBox(doc, x, y, w, h, title, subtitle) {
  // Button-like rounded rectangle
  doc.setDrawColor(200);
  doc.setLineWidth(1);
  doc.roundedRect(x, y, w, h, 10, 10);

  // Text inside
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(title, x + 14, y + 20);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(90);
  const wrapped = doc.splitTextToSize(subtitle, w - 28);
  doc.text(wrapped, x + 14, y + 38);
  doc.setTextColor(0);

  return y + h;
}

async function downloadPdf() {
  if (!lastGenerated) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const margin = 44;
  const contentW = pageW - margin * 2;

  let y = 56;

  // Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Milestone Update", margin, y);

  y += 18;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text("Scan the QR or open the link to update milestones (no app needed).", margin, y);
  doc.setTextColor(0);

  y += 18;
  drawDivider(doc, margin, y, contentW);
  y += 18;

  // Order details
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(`Order: ${lastGenerated.orderNumber}`, margin, y);

  y += 18;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.text(`Pick up: ${lastGenerated.pickupLocation}`, margin, y);
  y += 16;
  doc.text(`Delivery: ${lastGenerated.deliveryLocation}`, margin, y);

  y += 18;
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(`Link expires in ${lastGenerated.expiresInMinutes} minutes`, margin, y);
  doc.setTextColor(0);

  y += 18;
  drawDivider(doc, margin, y, contentW);
  y += 18;

  // Layout: QR left + instructions right
  const qrSize = 240;
  const qrX = margin;
  const qrY = y;

  doc.addImage(lastGenerated.qrDataUrl, "PNG", qrX, qrY, qrSize, qrSize);

  const ix = qrX + qrSize + 18;
  const iw = pageW - margin - ix;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Driver steps", ix, qrY + 16);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);

  const steps = [
    "1) Scan the QR code (camera).",
    "2) The page opens on your phone.",
    "3) Tap one of the buttons below.",
    "4) Tap Submit (location will be captured automatically)."
  ];

  let sy = qrY + 40;
  const lineGap = 16;

  for (const s of steps) {
    const wrapped = doc.splitTextToSize(s, iw);
    doc.text(wrapped, ix, sy);
    sy += lineGap * wrapped.length;
  }

  // Big “button style” boxes under QR+instructions
  y = qrY + qrSize + 22;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Buttons you will see on the page:", margin, y);
  y += 10;

  const boxW = contentW;
  const boxH = 62;

  y += 10;
  y = drawButtonBox(
    doc,
    margin,
    y,
    boxW,
    boxH,
    `✅ Pick up from ${lastGenerated.pickupLocation}`,
    "Use this when you have collected the shipment from the pickup location."
  ) + 10;

  y = drawButtonBox(
    doc,
    margin,
    y,
    boxW,
    boxH,
    `✅ Delivered at ${lastGenerated.deliveryLocation}`,
    "Use this when the shipment is delivered at the delivery location."
  ) + 10;

  y = drawButtonBox(
    doc,
    margin,
    y,
    boxW,
    boxH,
    "⚠️ Delay",
    "Use this if you are delayed. Select a reason and add notes (optional)."
  ) + 12;

  // Direct link section
  drawDivider(doc, margin, y, contentW);
  y += 16;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Direct link (if QR scan is not possible):", margin, y);

  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const wrappedLink = doc.splitTextToSize(lastGenerated.link, contentW);
  doc.text(wrappedLink, margin, y);
  y += 12 * wrappedLink.length + 10;

  // Footer
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(
    "Tip: This PDF can be opened on mobile. Zoom in if needed.",
    margin,
    Math.min(y + 10, pageH - 36)
  );
  doc.setTextColor(0);

  doc.save(`milestone-qr-${lastGenerated.orderNumber}.pdf`);
}

pdfBtn.addEventListener("click", downloadPdf);

genBtn.addEventListener("click", async () => {
  out.style.display = "none";
  out.innerHTML = "";
  qrWrap.style.display = "none";
  pdfBtn.style.display = "none";
  lastGenerated = null;

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

    out.style.display = "block";
    out.innerHTML = `
      <div><b>Milestone link:</b> <a href="${data.link}" target="_blank">${escapeHtml(data.link)}</a></div>
      <div style="margin-top:6px"><b>Live dashboard:</b> <a href="${data.dashboard}" target="_blank">${escapeHtml(data.dashboard)}</a></div>
      <div style="margin-top:6px" class="muted">Token expires in ${data.expiresInMinutes} minutes</div>
    `;

    const qrDataUrl = await renderQr(data.link);
    pdfBtn.style.display = "inline-block";

    lastGenerated = {
      orderNumber: payload.orderNumber,
      pickupLocation: payload.pickupLocation,
      deliveryLocation: payload.deliveryLocation,
      expiresInMinutes: data.expiresInMinutes,
      link: data.link,
      qrDataUrl
    };
  } catch (e) {
    out.style.display = "block";
    out.innerHTML = `<span style="color:#c22"><b>Error:</b> ${escapeHtml(e.message)}</span>`;
  }
});