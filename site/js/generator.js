import { toast, mountChrome, escapeHtml, statusPill, copyText } from './ui.js';
import { drawCoupon, couponToBlob, couponToDataUrl, downloadCoupon, qrMatrix } from './coupon.js';
import { createZip, downloadBlob } from './zip.js';
import { settings, saveSettings, loadCoupons, qrText, verifyUrl, randomCodes } from './sheet.js';

const PREVIEW_LIMIT = 24;
const ZIP_LIMIT = 250;   // beyond this a single in-memory zip starves the tab
const PRINT_LIMIT = 200; // 25 A4 pages; more than that and the print preview chokes
mountChrome('index.html');

const grid = document.getElementById('coupon-grid');
const previewNote = document.getElementById('preview-note');
const filters = document.getElementById('filters');
const settingsDialog = document.getElementById('settings');
const settingsForm = document.getElementById('settings-form');
const reloadBtn = document.getElementById('reload-btn');
let all = [];
let renderToken = 0;

/** Attaches the QR grid lazily: only coupons that get drawn pay for it. */
function withQr(coupon) {
  if (!coupon.qr) coupon.qr = qrMatrix(qrText(coupon.code));
  return coupon;
}

function filtered() {
  const q = filters.q.value.trim().toLowerCase();
  const status = filters.status.value;
  return all.filter((coupon) => (!status || coupon.status === status)
    && (!q || coupon.code.toLowerCase().includes(q) || coupon.note.toLowerCase().includes(q)));
}

function renderStats() {
  const count = (status) => all.filter((coupon) => coupon.status === status).length;
  const cards = [
    { label: 'أكواد في الجدول', value: all.length, cls: '' },
    { label: 'صالحة', value: count('active'), cls: 'is-ok' },
    { label: 'مستخدمة', value: count('used'), cls: 'is-gold' },
    { label: 'ملغاة', value: count('void'), cls: 'is-bad' },
  ];
  const host = document.getElementById('stats');
  host.hidden = false;
  host.innerHTML = cards.map((card) => `
    <div class="stat ${card.cls}">
      <span class="label">${card.label}</span>
      <span class="value">${card.value}</span>
    </div>`).join('');
}

async function renderPreviews() {
  const token = ++renderToken;
  const list = filtered();
  document.getElementById('result-hint').textContent = `${list.length} كوبون`;
  grid.innerHTML = list.length ? '' : '<p class="empty">لا توجد كوبونات مطابقة.</p>';
  const shown = list.slice(0, PREVIEW_LIMIT);
  for (const coupon of shown) {
    if (token !== renderToken) return; // a newer filter took over
    const card = document.createElement('div');
    card.className = 'coupon-card';
    const canvas = document.createElement('canvas');
    card.appendChild(canvas);
    card.insertAdjacentHTML('beforeend', `
      <div class="row">
        <span class="code">${escapeHtml(coupon.code)}</span>
        ${coupon.status === 'active' ? '' : statusPill(coupon.status)}
        <span class="spacer"></span>
        <button class="btn sm ghost" data-copy>نسخ الرابط</button>
        <button class="btn sm" data-png>PNG</button>
      </div>`);
    grid.appendChild(card);
    await drawCoupon(canvas, withQr(coupon), { scale: 1 });
    card.querySelector('[data-png]').addEventListener('click', () => downloadCoupon(withQr(coupon)));
    card.querySelector('[data-copy]').addEventListener('click', async () => {
      await copyText(verifyUrl(coupon.code));
      toast('تم نسخ رابط الكشف', 'ok');
    });
  }
  previewNote.textContent = list.length > shown.length
    ? `يُعرض ${shown.length} من ${list.length} كوبوناً — استخدم «تحميل الكل» أو «طباعة A4» للحصول عليها جميعاً.`
    : '';
}

async function reload() {
  const config = settings();
  document.getElementById('setup').hidden = Boolean(config.sheetUrl);
  if (!config.sheetUrl) {
    document.getElementById('result').hidden = true;
    document.getElementById('stats').hidden = true;
    return;
  }
  reloadBtn.disabled = true;
  reloadBtn.textContent = 'جارٍ القراءة…';
  try {
    all = await loadCoupons(config);
    renderStats();
    document.getElementById('result').hidden = false;
    document.getElementById('source-sub').textContent =
      `${all.length} كود من جدول Google Sheets — آخر تحديث ${new Date().toLocaleTimeString('ar-EG-u-nu-latn')}`;
    if (!all.length) toast('الجدول فارغ — أضف الأكواد تحت عمود «الكود».', 'bad');
    await renderPreviews();
  } catch (err) {
    toast(err.message, 'bad');
    document.getElementById('source-sub').textContent = err.message;
  } finally {
    reloadBtn.disabled = false;
    reloadBtn.textContent = 'تحديث من الجدول';
  }
}

// ------------------------------------------------------------- exports ---
document.getElementById('download-zip').addEventListener('click', async (event) => {
  const list = filtered();
  if (!list.length) return toast('لا توجد كوبونات للتحميل', 'bad');
  if (list.length > ZIP_LIMIT
      && !confirm(`سيتم تحميل أول ${ZIP_LIMIT} كوبوناً فقط في ملف واحد. ضيّق البحث لتحميل الباقي. متابعة؟`)) return;
  const button = event.currentTarget;
  const batch = list.slice(0, ZIP_LIMIT);
  button.disabled = true;
  try {
    const files = [];
    for (const [index, coupon] of batch.entries()) {
      button.textContent = `تجهيز ${index + 1}/${batch.length}…`;
      const blob = await couponToBlob(withQr(coupon), 3);
      files.push({ name: `${coupon.code.replace(/[\\/:*?"<>|]/g, '_')}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    downloadBlob(createZip(files), `moshrefoon-coupons-${new Date().toISOString().slice(0, 10)}.zip`);
    toast('تم تجهيز الملف المضغوط', 'ok');
  } catch (err) {
    toast('تعذّر تجهيز الملف: ' + err.message, 'bad');
  } finally {
    button.disabled = false;
    button.textContent = 'تحميل الكل (ZIP)';
  }
});

document.getElementById('print-btn').addEventListener('click', async (event) => {
  const list = filtered();
  if (!list.length) return toast('لا توجد كوبونات للطباعة', 'bad');
  if (list.length > PRINT_LIMIT
      && !confirm(`ستُطبع أول ${PRINT_LIMIT} كوبوناً فقط. ضيّق البحث لطباعة الباقي. متابعة؟`)) return;
  const button = event.currentTarget;
  const sheet = document.getElementById('print-sheet');
  const batch = list.slice(0, PRINT_LIMIT);
  button.disabled = true;
  sheet.innerHTML = '';
  try {
    for (const [index, coupon] of batch.entries()) {
      button.textContent = `تجهيز ${index + 1}/${batch.length}…`;
      const slot = document.createElement('div');
      slot.className = 'slot';
      const img = new Image();
      img.alt = coupon.code;
      img.src = await couponToDataUrl(withQr(coupon), 2);
      slot.appendChild(img);
      sheet.appendChild(slot);
    }
    await Promise.all([...sheet.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
    window.print();
  } finally {
    button.disabled = false;
    button.textContent = 'طباعة A4';
  }
});

// ------------------------------------------------------------ settings ---
function openSettings() {
  const config = settings();
  for (const name of ['sheetUrl', 'defaultAmount', 'qrContent', 'scriptUrl', 'scriptKey']) {
    settingsForm.elements[name].value = config[name] ?? '';
  }
  settingsDialog.showModal();
}

settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  const values = Object.fromEntries(
    ['sheetUrl', 'defaultAmount', 'qrContent', 'scriptUrl', 'scriptKey']
      .map((name) => [name, settingsForm.elements[name].value.trim()]));
  if (!saveSettings(values)) toast('تعذّر الحفظ على هذا الجهاز (وضع التصفح الخاص؟)', 'bad');
  else toast('تم حفظ الإعدادات', 'ok');
  all.forEach((coupon) => { delete coupon.qr; }); // QR content may have changed
  reload();
});

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.querySelectorAll('[data-open-settings]').forEach((el) => el.addEventListener('click', openSettings));
reloadBtn.addEventListener('click', reload);

let filterTimer = null;
filters.addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(renderPreviews, 200); });
filters.addEventListener('submit', (event) => { event.preventDefault(); renderPreviews(); });

// ---------------------------------------------------------- new codes ---
document.getElementById('codes-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const count = Math.min(2000, Math.max(1, Number(form.count.value) || 10));
  const prefix = form.prefix.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'MSH';
  const existing = new Set(all.map((coupon) => coupon.code.toUpperCase()));
  const codes = randomCodes(count + existing.size, prefix).filter((code) => !existing.has(code)).slice(0, count);
  document.getElementById('codes-text').value = codes.join('\n');
  document.getElementById('codes-out').hidden = false;
});
document.getElementById('copy-codes').addEventListener('click', async () => {
  await copyText(document.getElementById('codes-text').value);
  toast('تم النسخ — الصقها في عمود «الكود» في الجدول', 'ok');
});

reload();
