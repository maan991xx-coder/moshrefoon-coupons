import { api, toast, fmtDate, mountChrome, escapeHtml } from '/js/ui.js';
import { drawCoupon } from '/js/coupon.js';

const VERDICTS = {
  valid:     { cls: 'valid', icon: '✔', title: 'كوبون صالح',        desc: 'هذا الكوبون مولّد من هذا الموقع ولم يُستخدم بعد.' },
  used:      { cls: 'used',  icon: '⟳', title: 'مستخدم مسبقاً',      desc: 'الكوبون صحيح لكنه استُخدم من قبل.' },
  void:      { cls: 'bad',   icon: '⊘', title: 'كوبون ملغى',         desc: 'تم إلغاء هذا الكوبون من لوحة التحكم.' },
  expired:   { cls: 'bad',   icon: '⌛', title: 'انتهت صلاحيته',      desc: 'تجاوز الكوبون تاريخ انتهاء الصلاحية.' },
  unknown:   { cls: 'bad',   icon: '✕', title: 'كوبون غير معروف',    desc: 'هذا الرقم غير موجود في سجلات الموقع — لم يُولَّد من هنا.' },
  forged:    { cls: 'bad',   icon: '⚠', title: 'توقيع غير صالح',      desc: 'الرمز لا يحمل توقيع هذا الموقع، أي أنه غير مولّد منه.' },
  malformed: { cls: 'bad',   icon: '✕', title: 'صيغة غير صحيحة',      desc: 'تعذّرت قراءة رقم الكوبون. تأكد من الرمز وأعد المحاولة.' },
};

let session = { authenticated: false };
let current = null;

const outcome = document.getElementById('outcome');
const video = document.getElementById('video');
const placeholder = document.getElementById('placeholder');
const frame = document.getElementById('frame');
const cameraBtn = document.getElementById('camera-btn');
const stopBtn = document.getElementById('stop-btn');
const scanHint = document.getElementById('scan-hint');
let stream = null;
let scanTimer = null;

async function boot() {
  session = await api('/api/session').catch(() => ({ authenticated: false }));
  if (session.authenticated) mountChrome('/verify');
  const token = tokenFromLocation();
  if (token) {
    document.querySelector('#manual-form input[name=code]').value = token.split('.')[0];
    await verify(token);
  }
}

function tokenFromLocation() {
  const path = location.pathname.match(/^\/v\/(.+)$/);
  if (path) return decodeURIComponent(path[1]);
  const params = new URLSearchParams(location.search);
  return params.get('token') || params.get('code') || '';
}

async function verify(token) {
  try {
    const data = await api('/api/verify?token=' + encodeURIComponent(token));
    current = data;
    render(data);
  } catch (err) {
    render({ result: err.data?.result || 'malformed', coupon: null });
  }
}

function detailRows(coupon) {
  if (!coupon) return '';
  const rows = [
    ['رقم الكوبون', `<span class="mono">${escapeHtml(coupon.code)}</span>`],
    ['قيمة الخصم', escapeHtml(coupon.amount)],
    ['الدفعة', `<span class="mono">${escapeHtml(coupon.batchRef ?? '—')}</span>`],
    ['تاريخ التوليد', fmtDate(coupon.createdAt)],
  ];
  if (coupon.expiresAt) rows.push(['ينتهي في', fmtDate(coupon.expiresAt)]);
  if (coupon.usedAt) rows.push(['تاريخ الاستخدام', fmtDate(coupon.usedAt)]);
  return `<dl class="kv">${rows.map(([key, value]) => `<dt>${key}</dt><dd${value.includes('mono') ? ' class="mono"' : ''}>${value}</dd>`).join('')}</dl>`;
}

function render(data) {
  const verdict = VERDICTS[data.result] ?? VERDICTS.malformed;
  const coupon = data.coupon;
  const canRedeem = session.authenticated && data.result === 'valid';
  const canRestore = session.authenticated && data.result === 'used';

  outcome.hidden = false;
  outcome.innerHTML = `
    <div class="verdict ${verdict.cls}" style="margin-top:18px">
      <div class="icon">${verdict.icon}</div>
      <div class="title">${verdict.title}</div>
      <div class="desc">${verdict.desc}</div>
    </div>
    ${coupon ? `<div class="card" style="margin-top:16px">
        <div class="card-title"><h2>تفاصيل الكوبون</h2></div>
        ${detailRows(coupon)}
        ${session.authenticated ? '<canvas id="coupon-preview" style="width:100%;height:auto;margin-top:16px;border-radius:10px"></canvas>' : ''}
      </div>` : ''}
    ${canRedeem ? `<button class="btn ok block" id="redeem-btn" style="margin-top:16px;padding:16px;font-size:1.05rem">تم الإستخدام</button>
      <p class="help" style="text-align:center;margin-top:8px">اضغط بعد تسليم الخصم للعميل — لا يمكن استخدام الكوبون مرة أخرى.</p>` : ''}
    ${canRestore ? `<button class="btn ghost block" id="restore-btn" style="margin-top:16px">إلغاء علامة الاستخدام (تراجع)</button>` : ''}
    ${!session.authenticated && data.result === 'valid'
      ? '<p class="help" style="text-align:center;margin-top:14px"><a href="/login?next=/verify">سجّل الدخول</a> لتتمكن من تعليم الكوبون كمستخدم.</p>' : ''}`;

  outcome.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const preview = document.getElementById('coupon-preview');
  if (preview && coupon?.qr) drawCoupon(preview, coupon, { scale: 2 }).catch(() => {});

  document.getElementById('redeem-btn')?.addEventListener('click', redeem);
  document.getElementById('restore-btn')?.addEventListener('click', restore);
}

async function redeem() {
  const button = document.getElementById('redeem-btn');
  button.disabled = true;
  button.textContent = 'جارٍ التسجيل…';
  try {
    const data = await api(`/api/coupons/${encodeURIComponent(current.coupon.code)}/redeem`, { method: 'POST' });
    toast('تم تسجيل استخدام الكوبون', 'ok');
    render({ result: 'used', coupon: data.coupon });
  } catch (err) {
    toast(err.message, 'bad');
    if (err.data?.coupon) render({ result: err.data.error === 'expired' ? 'expired' : 'used', coupon: err.data.coupon });
    else { button.disabled = false; button.textContent = 'تم الإستخدام'; }
  }
}

async function restore() {
  try {
    const data = await api(`/api/coupons/${encodeURIComponent(current.coupon.code)}/restore`, { method: 'POST' });
    toast('تم التراجع، الكوبون صالح مجدداً', 'ok');
    render({ result: 'valid', coupon: data.coupon });
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// ------------------------------------------------------------------ camera ---
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/jsQR.js';
    script.onload = () => resolve(window.jsQR);
    script.onerror = () => reject(new Error('تعذّر تحميل قارئ الرموز'));
    document.head.appendChild(script);
  });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('المتصفح لا يدعم الكاميرا — استخدم الإدخال اليدوي', 'bad');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
  } catch {
    toast('تعذّر فتح الكاميرا. تأكد من السماح بالوصول (ويلزم https).', 'bad');
    return;
  }
  video.srcObject = stream;
  await video.play();
  placeholder.hidden = true;
  frame.hidden = false;
  cameraBtn.hidden = true;
  stopBtn.hidden = false;
  scanHint.textContent = 'جارٍ البحث عن رمز…';

  const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  const jsQR = detector ? null : await loadJsQr().catch(() => null);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const tick = async () => {
    if (!stream) return;
    let text = null;
    try {
      if (detector) {
        const [hit] = await detector.detect(video);
        text = hit?.rawValue ?? null;
      } else if (jsQR && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const frameData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        text = jsQR(frameData.data, frameData.width, frameData.height)?.data ?? null;
      }
    } catch { /* keep scanning */ }

    if (text) {
      stopCamera();
      scanHint.textContent = '';
      await verify(text);
      return;
    }
    scanTimer = setTimeout(tick, detector ? 220 : 120);
  };
  tick();
}

function stopCamera() {
  clearTimeout(scanTimer);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  placeholder.hidden = false;
  frame.hidden = true;
  cameraBtn.hidden = false;
  stopBtn.hidden = true;
  scanHint.textContent = '';
}

cameraBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
document.getElementById('manual-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = event.target.code.value.trim();
  if (value) verify(value);
});
window.addEventListener('pagehide', stopCamera);

boot();
