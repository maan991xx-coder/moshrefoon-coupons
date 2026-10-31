/* ===========================================================================
   قراءة الأكواد من Google Sheets | Reads coupon codes from a Google Sheet
   The sheet is the only database: one row per coupon, the code column drives
   the QR, and the status column is what the verify page trusts.
   ========================================================================= */

const STORE_KEY = 'moshrefoon.settings';
const DEFAULTS = { sheetUrl: '', defaultAmount: '10', qrContent: 'link', scriptUrl: '', scriptKey: '' };

/** Repo config (config.js) first, then whatever was saved on this device. */
export function settings() {
  let local = {};
  try { local = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { /* private mode */ }
  const merged = { ...DEFAULTS, ...(window.MOSHREFOON_CONFIG ?? {}) };
  for (const [key, value] of Object.entries(local)) if (value !== '' && value != null) merged[key] = value;
  return merged;
}

export function saveSettings(values) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(values)); return true; } catch { return false; }
}

/**
 * Turns whatever link the user pasted into a CSV download URL.
 *  …/d/e/<pubId>/pubhtml        → …/d/e/<pubId>/pub?output=csv
 *  …/d/<id>/edit#gid=123        → …/d/<id>/gviz/tq?tqx=out:csv&gid=123
 */
export function csvUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { return ''; }
  if (!/docs\.google\.com$/.test(url.hostname)) return text; // any other CSV host

  const gid = url.searchParams.get('gid') || (url.hash.match(/gid=(\d+)/) || [])[1] || '';
  const published = url.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/);
  if (published) {
    const out = new URL(`https://docs.google.com/spreadsheets/d/e/${published[1]}/pub`);
    out.searchParams.set('output', 'csv');
    if (gid) out.searchParams.set('gid', gid);
    if (url.searchParams.get('single')) out.searchParams.set('single', 'true');
    return out.toString();
  }
  const plain = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (plain) {
    const out = new URL(`https://docs.google.com/spreadsheets/d/${plain[1]}/gviz/tq`);
    out.searchParams.set('tqx', 'out:csv');
    if (gid) out.searchParams.set('gid', gid);
    return out.toString();
  }
  return text;
}

/** RFC 4180 CSV → rows of strings (quotes, escaped quotes, newlines in cells). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const norm = (value) => String(value ?? '').trim().toLowerCase()
  .replace(/[ً-ْ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/\s+/g, ' ');

const COLUMNS = {
  code:   ['الكود', 'كود', 'رقم الكوبون', 'الكوبون', 'code', 'coupon', 'barcode', 'باركود', 'الباركود'],
  amount: ['القيمه', 'قيمه الخصم', 'الخصم', 'المبلغ', 'amount', 'value'],
  status: ['الحاله', 'status', 'state'],
  usedAt: ['تاريخ الاستخدام', 'تاريخ الإستخدام', 'used at', 'used_at', 'usedat'],
  note:   ['ملاحظه', 'الدفعه', 'note', 'batch'],
};

/** Sheet wording → active | used | void. Blank means not used yet. */
export function normStatus(value) {
  const v = norm(value);
  if (!v || ['صالح', 'فعال', 'جديد', 'active', 'valid', 'new'].includes(v)) return 'active';
  if (/مستخدم|استخدم|استخدام|مستعمل|used|redeemed|نعم|yes|true|✓|✔/.test(v)) return 'used';
  if (/ملغ|void|cancel|disabled/.test(v)) return 'void';
  return 'active';
}

/** CSV rows → coupons. Without a recognisable header, column A is the code. */
export function rowsToCoupons(rows, defaultAmount = '10') {
  if (!rows.length) return [];
  const header = rows[0].map(norm);
  const find = (names) => header.findIndex((cell) => names.map(norm).includes(cell));
  let index = Object.fromEntries(Object.entries(COLUMNS).map(([key, names]) => [key, find(names)]));
  let body = rows.slice(1);
  if (index.code < 0) { index = { code: 0, amount: -1, status: -1, usedAt: -1, note: -1 }; body = rows; }

  const seen = new Set();
  const coupons = [];
  body.forEach((row, i) => {
    const code = String(row[index.code] ?? '').trim();
    if (!code || seen.has(code.toUpperCase())) return;
    seen.add(code.toUpperCase());
    const pick = (key) => (index[key] >= 0 ? String(row[index[key]] ?? '').trim() : '');
    coupons.push({
      code,
      amount: pick('amount') || defaultAmount,
      status: normStatus(pick('status')),
      usedAt: pick('usedAt'),
      note: pick('note'),
      row: i + (body === rows ? 1 : 2), // sheet row number, for humans
    });
  });
  return coupons;
}

export async function loadCoupons(config = settings()) {
  const url = csvUrl(config.sheetUrl);
  if (!url) throw new Error('لم يُضبط رابط جدول Google Sheets بعد — افتح «الإعدادات».');
  let response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error('تعذّر الوصول إلى الجدول. تأكد من نشره على الويب أو مشاركته «لأي شخص لديه الرابط».');
  }
  const text = await response.text();
  if (!response.ok || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('الجدول غير متاح للقراءة. انشره على الويب بصيغة CSV أو اجعل مشاركته «أي شخص لديه الرابط».');
  }
  return rowsToCoupons(parseCsv(text), config.defaultAmount || '10');
}

/** Same folder as the current page, so it works on any GitHub Pages path. */
export function siteBase() {
  return new URL('.', location.href).toString();
}

export function verifyUrl(code) {
  return `${siteBase()}verify.html?c=${encodeURIComponent(code)}`;
}

/** What goes inside the QR for this coupon. */
export function qrText(code, config = settings()) {
  return config.qrContent === 'code' ? code : verifyUrl(code);
}

/** A scanned QR may hold a verify link or the bare code. */
export function codeFromScan(text) {
  const value = String(text || '').trim();
  try {
    const url = new URL(value);
    return url.searchParams.get('c') || url.searchParams.get('code') || value;
  } catch {
    return value;
  }
}

// ------------------------------------------------- optional Apps Script ---
async function callScript(config, params) {
  const url = new URL(config.scriptUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url.toString(), { cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!data) throw new Error('رد غير مفهوم من Apps Script — تأكد من نشره «لأي شخص».');
  if (!data.ok) throw Object.assign(new Error(data.message || 'تعذّر إتمام الطلب'), { data });
  return data;
}

/** Live lookup through the script (skips Google's ~5-minute publish cache). */
export function scriptLookup(code, config = settings()) {
  return callScript(config, { action: 'status', code });
}

export function scriptRedeem(code, config = settings()) {
  return callScript(config, { action: 'redeem', code, key: config.scriptKey || '' });
}

export function scriptRestore(code, config = settings()) {
  return callScript(config, { action: 'restore', code, key: config.scriptKey || '' });
}

/** Fresh codes for the user to paste into the sheet. No 0/O/1/I to misread. */
export function randomCodes(count, prefix = 'MSH') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const out = new Set();
  while (out.size < count) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    out.add(`${prefix}-${chars.slice(0, 4)}-${chars.slice(4)}`);
  }
  return [...out];
}
