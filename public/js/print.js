import { api, toast, mountChrome, escapeHtml } from '/js/ui.js';
import { couponToDataUrl } from '/js/coupon.js';

mountChrome('/coupons');

const PER_SHEET = 100; // rendering more than this in one tab gets slow and memory-hungry
const params = new URLSearchParams(location.search);
const pageNumber = Math.max(1, Number(params.get('page') || 1));
const sheet = document.getElementById('sheet');
const sub = document.getElementById('sheet-sub');

async function fetchCoupons() {
  if (params.get('batch')) {
    const { batch, coupons } = await api('/api/batches/' + encodeURIComponent(params.get('batch')));
    return { title: `دفعة ${batch.ref}`, coupons };
  }
  const search = new URLSearchParams();
  for (const key of ['q', 'status', 'batch']) if (params.get(key)) search.set(key, params.get(key));
  search.set('limit', '500');
  const { coupons } = await api('/api/coupons?' + search.toString());
  return { title: 'الكوبونات المحددة', coupons };
}

function pageLink(target) {
  const next = new URLSearchParams(params);
  next.set('page', String(target));
  return '/print?' + next.toString();
}

try {
  const { title, coupons } = await fetchCoupons();
  const pages = Math.max(1, Math.ceil(coupons.length / PER_SHEET));
  const slice = coupons.slice((pageNumber - 1) * PER_SHEET, pageNumber * PER_SHEET);

  if (!coupons.length) {
    sub.textContent = 'لا توجد كوبونات للطباعة.';
  } else {
    for (const [index, coupon] of slice.entries()) {
      sub.textContent = `جارٍ التجهيز ${index + 1}/${slice.length}…`;
      const slot = document.createElement('div');
      slot.className = 'slot';
      const img = new Image();
      img.alt = coupon.code;
      img.src = await couponToDataUrl(coupon, 2);
      slot.appendChild(img);
      sheet.appendChild(slot);
    }
    sub.textContent = `${title} — ${coupons.length} كوبون، كل صفحة A4 تحمل ٨ كوبونات.`
      + (pages > 1 ? ` (مجموعة ${pageNumber} من ${pages})` : '');

    if (pages > 1) {
      const nav = document.createElement('p');
      nav.className = 'help no-print';
      nav.style.marginTop = '14px';
      nav.innerHTML = Array.from({ length: pages }, (_, i) => i + 1).map((n) =>
        n === pageNumber ? `<strong>${n}</strong>` : `<a href="${escapeHtml(pageLink(n))}">${n}</a>`).join(' · ');
      nav.insertAdjacentHTML('afterbegin', 'مجموعات الطباعة: ');
      sheet.after(nav);
    }
    if (params.get('auto') === '1') window.print();
  }
} catch (err) {
  sub.textContent = 'تعذّر التجهيز: ' + err.message;
  toast(err.message, 'bad');
}

document.getElementById('print-btn').addEventListener('click', () => window.print());
