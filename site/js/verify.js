import { toast, mountChrome, escapeHtml } from './ui.js';
import { drawCoupon, qrMatrix } from './coupon.js';
import {
  settings, loadCoupons, normStatus, codeFromScan, qrText,
  scriptLookup, scriptRedeem, scriptRestore,
} from './sheet.js';

const VERDICTS = {
  valid:   { cls: 'valid', icon: '✔', title: 'كوبون صالح',      desc: 'هذا الكود موجود في جدول الأكواد ولم يُستخدم بعد.' },
  used:    { cls: 'used',  icon: '⟳', title: 'مستخدم مسبقاً',    desc: 'الكود صحيح لكنه مُعلَّم «مستخدم» في الجدول.' },
  void:    { cls: 'bad',   icon: '⊘', title: 'كوبون ملغى',       desc: 'هذا الكود مُعلَّم «ملغى» في الجدول.' },
  unknown: { cls: 'bad',   icon: '✕', title: 'كوبون غير معروف',  desc: 'هذا الكود غير موجود في جدول الأكواد.' },
  error:   { cls: 'bad',   icon: '⚠', title: 'تعذّر الكشف',      desc: '' },
};
const RESULT_OF = { active: 'valid', used: 'used', void: 'void' };

mountChrome('verify.html');

const outcome = document.getElementById('outcome');
const video = document.getElementById('video');
const placeholder = document.getElementById('placeholder');
const frame = document.getElementById('frame');
const cameraBtn = document.getElementById('camera-btn');
const stopBtn = document.getElementById('stop-btn');
const scanHint = document.getElementById('scan-hint');
let stream = null;
let scanTimer = null;
let current = null;

const canWrite = () => { const c = settings(); return Boolean(c.scriptUrl && c.scriptKey); };

/** Live through Apps Script when configured, otherwise the published CSV. */
async function lookup(code) {
  const config = settings();
  if (config.scriptUrl) {
    const data = await scriptLookup(code, config);
    return data.found ? { ...data.coupon, status: normStatus(data.coupon.status) } : null;
  }
  const coupons = await loadCoupons(config);
  const wanted = code.toUpperCase();
  return coupons.find((coupon) => coupon.code.toUpperCase() === wanted) ?? null;
}

async function verify(raw) {
  const code = codeFromScan(raw);
  if (!code) return;
  document.querySelector('#manual-form input[name=code]').value = code;
  outcome.hidden = false;
  outcome.innerHTML = '<p class="empty">جارٍ الكشف في الجدول…</p>';
  try {
    const coupon = await lookup(code);
    current = coupon;
    render(coupon ? RESULT_OF[coupon.status] : 'unknown', coupon);
  } catch (err) {
    render('error', null, err.message);
  }
}

function detailRows(coupon) {
  const rows = [
    ['رقم الكوبون', `<span class="mono">${escapeHtml(coupon.code)}</span>`],
    ['قيمة الخصم', escapeHtml(coupon.amount || settings().defaultAmount)],
  ];
  if (coupon.note) rows.push(['ملاحظة', escapeHtml(coupon.note)]);
  if (coupon.usedAt) rows.push(['تاريخ الاستخدام', escapeHtml(coupon.usedAt)]);
  if (coupon.row) rows.push(['الصف في الجدول', String(coupon.row)]);
  return `<dl class="kv">${rows.map(([key, value]) => `<dt>${key}</dt><dd${value.includes('mono') ? ' class="mono"' : ''}>${value}</dd>`).join('')}</dl>`;
}

function render(result, coupon, message = '') {
  const verdict = VERDICTS[result];
  const writable = canWrite();
  outcome.hidden = false;
  outcome.innerHTML = `
    <div class="verdict ${verdict.cls}" style="margin-top:18px">
      <div class="icon">${verdict.icon}</div>
      <div class="title">${verdict.title}</div>
      <div class="desc">${escapeHtml(message || verdict.desc)}</div>
    </div>
    ${coupon ? `<div class="card" style="margin-top:16px">
        <div class="card-title"><h2>تفاصيل الكوبون</h2></div>
        ${detailRows(coupon)}
        <canvas id="coupon-preview" style="width:100%;height:auto;margin-top:16px;border-radius:10px"></canvas>
      </div>` : ''}
    ${result === 'valid' && writable ? `<button class="btn ok block" id="redeem-btn" style="margin-top:16px;padding:16px;font-size:1.05rem">تم الإستخدام</button>
      <p class="help" style="text-align:center;margin-top:8px">اضغط بعد تسليم الخصم للعميل — يُكتب «مستخدم» في الجدول ولا يُقبل الكوبون مرة أخرى.</p>` : ''}
    ${result === 'valid' && !writable ? `<p class="help" style="text-align:center;margin-top:14px">
      بعد تسليم الخصم اكتب <b>مستخدم</b> في عمود «الحالة» لهذا الكود في الجدول${coupon?.row ? ` (الصف ${coupon.row})` : ''}.</p>` : ''}
    ${result === 'used' && writable ? '<button class="btn ghost block" id="restore-btn" style="margin-top:16px">إلغاء علامة الاستخدام (تراجع)</button>' : ''}`;

  outcome.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const preview = document.getElementById('coupon-preview');
  if (preview && coupon) {
    drawCoupon(preview, { ...coupon, amount: coupon.amount || settings().defaultAmount, qr: qrMatrix(qrText(coupon.code)) }, { scale: 2 })
      .catch(() => {});
  }
  document.getElementById('redeem-btn')?.addEventListener('click', redeem);
  document.getElementById('restore-btn')?.addEventListener('click', restore);
}

async function redeem() {
  const button = document.getElementById('redeem-btn');
  button.disabled = true;
  button.textContent = 'جارٍ التسجيل…';
  try {
    const data = await scriptRedeem(current.code);
    toast('تم تسجيل استخدام الكوبون في الجدول', 'ok');
    current = { ...current, ...data.coupon, status: 'used' };
    render('used', current);
  } catch (err) {
    toast(err.message, 'bad');
    if (err.data?.coupon) {
      current = { ...current, ...err.data.coupon, status: normStatus(err.data.coupon.status) };
      render(RESULT_OF[current.status], current);
    } else { button.disabled = false; button.textContent = 'تم الإستخدام'; }
  }
}

async function restore() {
  try {
    const data = await scriptRestore(current.code);
    toast('تم التراجع، الكوبون صالح مجدداً', 'ok');
    current = { ...current, ...data.coupon, status: 'active', usedAt: '' };
    render('valid', current);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// ------------------------------------------------------------------ camera ---
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/jsQR.js';
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
    toast('تعذّر فتح الكاميرا. تأكد من السماح بالوصول.', 'bad');
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
  verify(event.target.code.value);
});
window.addEventListener('pagehide', stopCamera);

const initial = new URLSearchParams(location.search);
if (initial.get('c') || initial.get('code')) verify(initial.get('c') || initial.get('code'));
