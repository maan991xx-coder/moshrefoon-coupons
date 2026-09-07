/* ===========================================================================
   رسم الكوبون على canvas: الخلفية الأصلية للتصميم + رمز QR أسفل الشعار يساراً
   One renderer used everywhere (preview, download, print) so what staff see on
   screen is exactly what comes out of the printer.
   ========================================================================= */

export const COUPON = { width: 794, height: 515 };

/* All coordinates are in artwork space (794 × 515) and scale with the canvas. */
const SPEC = {
  tile:   { x: 26, y: 160, w: 180, h: 232, r: 16 },
  qr:     { x: 46, y: 180, size: 140 },
  code:   { cx: 116, y: 346, size: 21 },
  hint:   { cx: 116, y: 368, size: 12.5 },
  badge:  { topStart: 252, topEnd: 542, bottom: 424, top: 364, slant: 19 },
  riyal:  { x: 263, y: 370, w: 80, h: 50 },
  amount: { x: 356, y: 397, size: 44 },
};

const ASSETS = { base: '/assets/coupon-base.png', riyal: '/assets/riyal.png' };
const INK = '#23252f';
const QR_DARK = '#111318';

let assetsPromise = null;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('تعذّر تحميل الصورة: ' + src));
    img.src = src;
  });
}

/** Web fonts must be resolved before canvas text is measured or drawn. */
async function ensureFonts() {
  if (!document.fonts?.load) return;
  try {
    await Promise.all([
      document.fonts.load('700 21px Cairo'),
      document.fonts.load('600 13px Cairo'),
      document.fonts.load('700 44px Cairo'),
    ]);
  } catch { /* offline: system fallbacks are fine */ }
}

/**
 * The artwork is a transparent ticket (its upper band shows the page through).
 * We flood-fill from the outside once to learn the ticket silhouette, then use
 * it as an opaque white backdrop — so a downloaded PNG is a complete coupon and
 * never a see-through one.
 */
function buildBackdrop(baseImg) {
  const { width: w, height: h } = COUPON;
  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(baseImg, 0, 0, w, h);
  const alpha = pctx.getImageData(0, 0, w, h).data;

  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (outside[i] || alpha[i * 4 + 3] > 8) return;
    outside[i] = 1; stack.push(i);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  const backdrop = document.createElement('canvas');
  backdrop.width = w; backdrop.height = h;
  const bctx = backdrop.getContext('2d');
  const image = bctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    if (outside[i]) continue;
    image.data[i * 4] = 255; image.data[i * 4 + 1] = 255;
    image.data[i * 4 + 2] = 255; image.data[i * 4 + 3] = 255;
  }
  bctx.putImageData(image, 0, 0);
  return backdrop;
}

async function assets() {
  if (!assetsPromise) {
    assetsPromise = (async () => {
      const [base, riyal] = await Promise.all([loadImage(ASSETS.base), loadImage(ASSETS.riyal)]);
      await ensureFonts();
      return { base, riyal, backdrop: buildBackdrop(base) };
    })();
  }
  return assetsPromise;
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws the QR with whole-pixel modules — half-pixel edges break scanners. */
function drawQr(ctx, qr, box, scale) {
  const modules = qr.modules;
  const n = qr.size;
  const device = Math.floor((box.size * scale) / n) * n;
  const cell = device / n;
  const originX = Math.round((box.x + box.size / 2) * scale - device / 2);
  const originY = Math.round((box.y + box.size / 2) * scale - device / 2);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = QR_DARK;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (modules[row * n + col] !== '1') continue;
      // merge horizontal runs into a single rect: fewer seams, crisper print
      let run = 1;
      while (col + run < n && modules[row * n + col + run] === '1') run++;
      ctx.fillRect(originX + col * cell, originY + row * cell, cell * run, cell);
      col += run - 1;
    }
  }
  ctx.restore();
}

function drawBadge(ctx, riyalImg, amount) {
  const b = SPEC.badge;
  ctx.save();
  ctx.fillStyle = '#050505';
  ctx.beginPath();
  ctx.moveTo(b.topStart, b.top);
  ctx.lineTo(b.topEnd, b.top);
  ctx.lineTo(b.topEnd - b.slant, b.bottom);
  ctx.lineTo(b.topStart - b.slant, b.bottom);
  ctx.closePath();
  ctx.fill();
  ctx.drawImage(riyalImg, SPEC.riyal.x, SPEC.riyal.y, SPEC.riyal.w, SPEC.riyal.h);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${SPEC.amount.size}px Cairo, system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.direction = 'ltr';
  ctx.fillText(String(amount), SPEC.amount.x, SPEC.amount.y);
  ctx.restore();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{code:string, amount:string, qr:{size:number,modules:string}}} coupon
 * @param {{scale?:number, hint?:string, forceBadge?:boolean, transparent?:boolean}} [options]
 */
export async function drawCoupon(canvas, coupon, options = {}) {
  const { base, riyal, backdrop } = await assets();
  const scale = options.scale ?? 1;
  const { width: w, height: h } = COUPON;

  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!options.transparent) ctx.drawImage(backdrop, 0, 0, w, h);
  ctx.drawImage(base, 0, 0, w, h);

  // A custom discount value paints over the value printed in the artwork.
  if (options.forceBadge || (coupon.amount && String(coupon.amount) !== '10')) {
    drawBadge(ctx, riyal, coupon.amount);
  }

  // ---- QR panel: under the campaign logo, on the left ----------------------
  const t = SPEC.tile;
  ctx.save();
  ctx.shadowColor = 'rgba(28, 26, 20, .22)';
  ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
  ctx.fillStyle = '#ffffff';
  roundedRect(ctx, t.x, t.y, t.w, t.h, t.r);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(184, 137, 43, .55)';
  ctx.lineWidth = 1.4;
  roundedRect(ctx, t.x + .7, t.y + .7, t.w - 1.4, t.h - 1.4, t.r - 1);
  ctx.stroke();
  ctx.restore();

  if (coupon.qr) drawQr(ctx, coupon.qr, SPEC.qr, scale);

  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.direction = 'ltr';
  ctx.font = `700 ${SPEC.code.size}px ui-monospace, "Cascadia Mono", Menlo, monospace`;
  ctx.fillText(coupon.code, SPEC.code.cx, SPEC.code.y);

  ctx.direction = 'rtl';
  ctx.fillStyle = '#7a6a48';
  ctx.font = `600 ${SPEC.hint.size}px Cairo, system-ui, sans-serif`;
  ctx.fillText(options.hint ?? 'امسح الرمز للتحقق', SPEC.hint.cx, SPEC.hint.y);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

export async function couponToBlob(coupon, scale = 3, options = {}) {
  const canvas = document.createElement('canvas');
  await drawCoupon(canvas, coupon, { ...options, scale });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export async function couponToDataUrl(coupon, scale = 2, options = {}) {
  const canvas = document.createElement('canvas');
  await drawCoupon(canvas, coupon, { ...options, scale });
  return canvas.toDataURL('image/png');
}

export async function downloadCoupon(coupon, scale = 3) {
  const blob = await couponToBlob(coupon, scale);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${coupon.code}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
