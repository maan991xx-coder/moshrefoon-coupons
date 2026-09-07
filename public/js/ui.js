/* أدوات مشتركة بين الصفحات | Shared front-end helpers */

const DATE_FMT = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

export function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DATE_FMT.format(date);
}

export const STATUS = {
  active: { label: 'صالح', cls: 'active' },
  used: { label: 'مستخدم', cls: 'used' },
  void: { label: 'ملغى', cls: 'void' },
};

export function statusPill(status) {
  const s = STATUS[status] ?? { label: status, cls: 'void' };
  return `<span class="pill ${s.cls}">${s.label}</span>`;
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 && !path.startsWith('/api/verify')) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('unauthorised');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || 'تعذّر إتمام الطلب');
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

export function toast(message, kind = '') {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 3800);
}

const NAV = [
  { href: '/', label: 'لوحة التحكم' },
  { href: '/coupons', label: 'الكوبونات' },
  { href: '/verify', label: 'كشف كوبون' },
];

/** Renders the shared top bar; `active` is one of the NAV hrefs. */
export function mountChrome(active) {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  bar.innerHTML = `
    <a class="brand" href="/">
      <img src="/assets/logo.png" alt="شعار حملة المشرفون للحج والعمرة">
      <span>كوبونات المشرفون</span>
    </a>
    <nav>
      ${NAV.map((item) => `<a href="${item.href}"${item.href === active ? ' aria-current="page"' : ''}>${item.label}</a>`).join('')}
      <a href="#" data-logout>خروج</a>
    </nav>`;
  document.body.prepend(bar);
  bar.querySelector('[data-logout]').addEventListener('click', async (event) => {
    event.preventDefault();
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  });
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const field = document.createElement('textarea');
  field.value = text;
  document.body.appendChild(field);
  field.select();
  document.execCommand('copy');
  field.remove();
  return Promise.resolve();
}
