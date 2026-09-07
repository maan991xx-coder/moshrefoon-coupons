import { api, toast, fmtDate, mountChrome, escapeHtml, statusPill, copyText } from '/js/ui.js';
import { drawCoupon, downloadCoupon } from '/js/coupon.js';

mountChrome('/coupons');

const PAGE_SIZE = 50;
const filters = document.getElementById('filters');
const list = document.getElementById('list');
const pager = document.getElementById('pager');
const detail = document.getElementById('detail');
let offset = 0;
let total = 0;
let rows = [];

const params = new URLSearchParams(location.search);
if (params.get('batch')) filters.batch.value = params.get('batch');
if (params.get('q')) filters.q.value = params.get('q');
if (params.get('status')) filters.status.value = params.get('status');

async function loadBatchOptions() {
  const { batches } = await api('/api/batches');
  const select = filters.batch;
  const wanted = params.get('batch') || '';
  select.innerHTML = '<option value="">كل الدفعات</option>' + batches.map((batch) =>
    `<option value="${escapeHtml(batch.ref)}">${escapeHtml(batch.ref)}${batch.note ? ' — ' + escapeHtml(batch.note) : ''}</option>`).join('');
  if (wanted) select.value = wanted;
}

function query() {
  const search = new URLSearchParams();
  if (filters.q.value.trim()) search.set('q', filters.q.value.trim());
  if (filters.status.value) search.set('status', filters.status.value);
  if (filters.batch.value) search.set('batch', filters.batch.value);
  return search;
}

async function load() {
  const search = query();
  search.set('limit', PAGE_SIZE);
  search.set('offset', offset);
  const data = await api('/api/coupons?' + search.toString());
  rows = data.coupons;
  total = data.total;
  renderTable();

  const printSearch = query();
  document.getElementById('print-link').href = '/print?' + printSearch.toString();
  history.replaceState(null, '', printSearch.toString() ? '/coupons?' + printSearch.toString() : '/coupons');
}

function renderTable() {
  if (!rows.length) {
    list.innerHTML = '<p class="empty">لا توجد كوبونات مطابقة.</p>';
    pager.hidden = true;
    return;
  }
  list.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>رقم الكوبون</th><th>الدفعة</th><th>القيمة</th><th>الحالة</th>
        <th>تاريخ التوليد</th><th>تاريخ الاستخدام</th><th></th>
      </tr></thead>
      <tbody>${rows.map((coupon, index) => `
        <tr>
          <td class="code">${escapeHtml(coupon.code)}</td>
          <td class="code">${escapeHtml(coupon.batchRef ?? '—')}</td>
          <td>${escapeHtml(coupon.amount)}</td>
          <td>${statusPill(coupon.status)}</td>
          <td>${fmtDate(coupon.createdAt)}</td>
          <td>${fmtDate(coupon.usedAt)}</td>
          <td class="actions">
            <button class="btn sm ghost" data-open="${index}">عرض</button>
            ${coupon.status === 'active' ? `<button class="btn sm ok" data-redeem="${index}">تم الإستخدام</button>` : ''}
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;

  pager.hidden = total <= PAGE_SIZE;
  document.getElementById('range').textContent = `${offset + 1} – ${Math.min(offset + PAGE_SIZE, total)} من ${total}`;
  document.getElementById('prev').disabled = offset === 0;
  document.getElementById('next').disabled = offset + PAGE_SIZE >= total;

  list.querySelectorAll('[data-open]').forEach((button) =>
    button.addEventListener('click', () => openDetail(rows[Number(button.dataset.open)])));
  list.querySelectorAll('[data-redeem]').forEach((button) =>
    button.addEventListener('click', () => redeem(rows[Number(button.dataset.redeem)].code)));
}

async function redeem(code) {
  if (!confirm(`تأكيد تسجيل استخدام الكوبون ${code}؟`)) return;
  try {
    await api(`/api/coupons/${encodeURIComponent(code)}/redeem`, { method: 'POST' });
    toast('تم تسجيل الاستخدام', 'ok');
    await load();
    if (detail.open) openDetail(rows.find((row) => row.code === code) ?? null);
  } catch (err) {
    toast(err.message, 'bad');
    load();
  }
}

async function openDetail(coupon) {
  if (!coupon) return detail.close();
  const { coupon: fresh, scans } = await api('/api/coupons/' + encodeURIComponent(coupon.code));
  document.getElementById('detail-title').textContent = fresh.code;
  await drawCoupon(document.getElementById('detail-canvas'), fresh, { scale: 2 });

  document.getElementById('detail-body').innerHTML = `
    <dl class="kv">
      <dt>الحالة</dt><dd>${statusPill(fresh.status)}</dd>
      <dt>الدفعة</dt><dd class="mono">${escapeHtml(fresh.batchRef ?? '—')}</dd>
      <dt>القيمة</dt><dd>${escapeHtml(fresh.amount)}</dd>
      <dt>تاريخ التوليد</dt><dd>${fmtDate(fresh.createdAt)}</dd>
      ${fresh.expiresAt ? `<dt>ينتهي في</dt><dd>${fmtDate(fresh.expiresAt)}</dd>` : ''}
      ${fresh.usedAt ? `<dt>استُخدم في</dt><dd>${fmtDate(fresh.usedAt)}</dd>` : ''}
      <dt>رابط التحقق</dt><dd class="mono" style="word-break:break-all;font-size:.8rem">${escapeHtml(fresh.url)}</dd>
    </dl>
    ${scans.length ? `<div style="margin-top:14px">
      <p class="lbl" style="font-weight:700;margin-bottom:6px">آخر عمليات الكشف</p>
      <div class="table-wrap"><table><tbody>
        ${scans.slice(0, 6).map((scan) => `<tr><td>${fmtDate(scan.at)}</td><td>${escapeHtml(scan.result)}</td><td>${escapeHtml(scan.actor)}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;

  const actions = document.getElementById('detail-actions');
  actions.innerHTML = `
    <button class="btn" data-download>تحميل PNG</button>
    <button class="btn ghost" data-copy>نسخ الرابط</button>
    ${fresh.status === 'active' ? '<button class="btn ok" data-redeem>تم الإستخدام</button>' : ''}
    ${fresh.status === 'used' ? '<button class="btn ghost" data-restore>تراجع عن الاستخدام</button>' : ''}
    ${fresh.status !== 'void' && fresh.status !== 'used' ? '<button class="btn danger" data-void>إلغاء الكوبون</button>' : ''}
    ${fresh.status === 'void' ? '<button class="btn ghost" data-unvoid>إعادة تفعيل</button>' : ''}`;

  actions.querySelector('[data-download]').addEventListener('click', () => downloadCoupon(fresh));
  actions.querySelector('[data-copy]').addEventListener('click', async () => {
    await copyText(fresh.url); toast('تم نسخ الرابط', 'ok');
  });
  actions.querySelector('[data-redeem]')?.addEventListener('click', () => redeem(fresh.code));
  actions.querySelector('[data-restore]')?.addEventListener('click', async () => {
    await api(`/api/coupons/${encodeURIComponent(fresh.code)}/restore`, { method: 'POST' });
    toast('تم التراجع', 'ok'); await load(); openDetail(fresh);
  });
  actions.querySelector('[data-void]')?.addEventListener('click', async () => {
    if (!confirm('إلغاء هذا الكوبون نهائياً؟')) return;
    await api(`/api/coupons/${encodeURIComponent(fresh.code)}/void`, { method: 'POST', body: { void: true } });
    toast('تم إلغاء الكوبون', 'ok'); await load(); openDetail(fresh);
  });
  actions.querySelector('[data-unvoid]')?.addEventListener('click', async () => {
    await api(`/api/coupons/${encodeURIComponent(fresh.code)}/void`, { method: 'POST', body: { void: false } });
    toast('تمت إعادة التفعيل', 'ok'); await load(); openDetail(fresh);
  });

  if (!detail.open) detail.showModal();
}

document.getElementById('close-detail').addEventListener('click', () => detail.close());
detail.addEventListener('click', (event) => { if (event.target === detail) detail.close(); });
filters.addEventListener('submit', (event) => { event.preventDefault(); offset = 0; load(); });
document.getElementById('prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); load(); });
document.getElementById('next').addEventListener('click', () => { offset += PAGE_SIZE; load(); });

await loadBatchOptions().catch(() => {});
await load().catch((err) => toast(err.message, 'bad'));
