import { api, toast, fmtDate, mountChrome, escapeHtml, copyText } from '/js/ui.js';
import { drawCoupon, couponToBlob, downloadCoupon } from '/js/coupon.js';
import { createZip, downloadBlob } from '/js/zip.js';

const PREVIEW_LIMIT = 24;
mountChrome('/');

const form = document.getElementById('generate-form');
const generateBtn = document.getElementById('generate-btn');
const result = document.getElementById('result');
const grid = document.getElementById('coupon-grid');
const previewNote = document.getElementById('preview-note');
let lastBatch = null;
let lastCoupons = [];

async function loadStats() {
  const stats = await api('/api/stats');
  const cards = [
    { label: 'إجمالي الكوبونات', value: stats.total, cls: '' },
    { label: 'كوبونات صالحة', value: stats.active, cls: 'is-ok' },
    { label: 'كوبونات مستخدمة', value: stats.used, cls: 'is-gold' },
    { label: 'عمليات كشف اليوم', value: stats.scansToday, cls: '' },
  ];
  document.getElementById('stats').innerHTML = cards.map((card) => `
    <div class="stat ${card.cls}">
      <span class="label">${card.label}</span>
      <span class="value">${card.value}</span>
    </div>`).join('');
}

async function loadBatches() {
  const { batches } = await api('/api/batches');
  const host = document.getElementById('batches');
  if (!batches.length) {
    host.innerHTML = '<p class="empty">لا توجد دفعات بعد — ابدأ بتوليد أول دفعة.</p>';
    return;
  }
  host.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>الدفعة</th><th>العدد</th><th>مستخدم</th><th>التاريخ</th><th></th></tr></thead>
      <tbody>${batches.slice(0, 8).map((batch) => `
        <tr>
          <td class="code">${escapeHtml(batch.ref)}${batch.note ? `<br><span class="help">${escapeHtml(batch.note)}</span>` : ''}</td>
          <td>${batch.total}</td>
          <td>${batch.used}</td>
          <td>${fmtDate(batch.created_at)}</td>
          <td class="actions">
            <a class="btn sm ghost" href="/coupons?batch=${encodeURIComponent(batch.ref)}">عرض</a>
            <a class="btn sm ghost" href="/print?batch=${encodeURIComponent(batch.ref)}" target="_blank" rel="noopener">طباعة</a>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

async function renderPreviews(coupons) {
  grid.innerHTML = '';
  const shown = coupons.slice(0, PREVIEW_LIMIT);
  for (const coupon of shown) {
    const card = document.createElement('div');
    card.className = 'coupon-card';
    const canvas = document.createElement('canvas');
    card.appendChild(canvas);
    card.insertAdjacentHTML('beforeend', `
      <div class="row">
        <span class="code">${escapeHtml(coupon.code)}</span>
        <span class="spacer"></span>
        <button class="btn sm ghost" data-copy>نسخ الرابط</button>
        <button class="btn sm" data-png>PNG</button>
      </div>`);
    grid.appendChild(card);
    await drawCoupon(canvas, coupon, { scale: 1 });
    card.querySelector('[data-png]').addEventListener('click', () => downloadCoupon(coupon));
    card.querySelector('[data-copy]').addEventListener('click', async () => {
      await copyText(coupon.url);
      toast('تم نسخ رابط التحقق', 'ok');
    });
  }
  previewNote.textContent = coupons.length > shown.length
    ? `يُعرض ${shown.length} من ${coupons.length} كوبوناً — استخدم «تحميل الكل» أو «طباعة الدفعة» للحصول عليها جميعاً.`
    : '';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  generateBtn.disabled = true;
  generateBtn.textContent = 'جارٍ التوليد…';
  try {
    const payload = {
      quantity: Number(data.get('quantity')),
      amount: String(data.get('amount') || '').trim(),
      note: String(data.get('note') || '').trim(),
      expiresAt: data.get('expiresAt') || null,
    };
    const { batch, coupons } = await api('/api/batches', { method: 'POST', body: payload });
    lastBatch = batch;
    lastCoupons = coupons;
    result.hidden = false;
    document.getElementById('result-title').textContent = `الكوبونات المولّدة — ${batch.ref}`;
    document.getElementById('result-hint').textContent = `${coupons.length} كوبون`;
    document.getElementById('print-batch').href = `/print?batch=${encodeURIComponent(batch.ref)}`;
    document.getElementById('export-csv').href = `/api/batches/${encodeURIComponent(batch.ref)}/export.csv`;
    toast(`تم توليد ${coupons.length} كوبوناً`, 'ok');
    await renderPreviews(coupons);
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    loadStats(); loadBatches();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'توليد الأكواد';
  }
});

const ZIP_LIMIT = 250; // beyond this a single in-memory zip starves the tab

document.getElementById('download-zip').addEventListener('click', async (event) => {
  if (!lastCoupons.length) return;
  const button = event.currentTarget;
  const batch = lastCoupons.slice(0, ZIP_LIMIT);
  if (lastCoupons.length > ZIP_LIMIT
      && !confirm(`سيتم تحميل أول ${ZIP_LIMIT} كوبوناً فقط في ملف واحد. للباقي استخدم صفحة الطباعة أو تصدير CSV. متابعة؟`)) return;
  button.disabled = true;
  try {
    const files = [];
    for (const [index, coupon] of batch.entries()) {
      button.textContent = `تجهيز ${index + 1}/${batch.length}…`;
      const blob = await couponToBlob(coupon, 3);
      files.push({ name: `${coupon.code}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    downloadBlob(createZip(files), `${lastBatch.ref}-coupons.zip`);
    toast('تم تجهيز الملف المضغوط', 'ok');
  } catch (err) {
    toast('تعذّر تجهيز الملف: ' + err.message, 'bad');
  } finally {
    button.disabled = false;
    button.textContent = 'تحميل الكل (ZIP)';
  }
});

loadStats().catch(() => {});
loadBatches().catch(() => {});
