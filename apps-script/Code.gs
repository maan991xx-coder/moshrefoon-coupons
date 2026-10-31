/**
 * كوبونات المشرفون — Google Apps Script (اختياري)
 *
 * يجعل زر «تم الإستخدام» في صفحة الكشف يكتب «مستخدم» في الجدول مباشرة،
 * ويقرأ حالة الكوبون لحظياً بدل انتظار تحديث النشر على الويب (حتى ٥ دقائق).
 *
 * التركيب (مرة واحدة):
 *  1. افتح جدول الأكواد ← الإضافات (Extensions) ← Apps Script، والصق هذا الملف كاملاً.
 *  2. غيّر SECRET_KEY أدناه إلى كلمة سر طويلة من اختيارك.
 *  3. Deploy ← New deployment ← النوع Web app:
 *       Execute as: Me   ·   Who has access: Anyone
 *     ثم انسخ رابط الـ Web app (ينتهي بـ /exec).
 *  4. في موقع الكوبونات ← الإعدادات: الصق الرابط في «رابط Apps Script» والكلمة في «المفتاح السري».
 */

const SECRET_KEY = 'غيّر-هذه-الكلمة';
const SHEET_NAME = ''; // اتركه فارغاً لاستخدام أول ورقة

const HEADERS = {
  code: ['الكود', 'كود', 'رقم الكوبون', 'الكوبون', 'code', 'coupon', 'barcode', 'باركود', 'الباركود'],
  amount: ['القيمة', 'قيمة الخصم', 'الخصم', 'المبلغ', 'amount', 'value'],
  status: ['الحالة', 'status', 'state'],
  usedAt: ['تاريخ الاستخدام', 'تاريخ الإستخدام', 'used at', 'used_at', 'usedat'],
  note: ['ملاحظة', 'الدفعة', 'note', 'batch'],
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'status') return json(status_(p.code));
    if (p.action === 'redeem' || p.action === 'restore') {
      if (String(p.key || '') !== SECRET_KEY) return json({ ok: false, error: 'key', message: 'المفتاح السري غير صحيح' });
      const lock = LockService.getScriptLock();
      lock.waitLock(10000); // two cashiers scanning the same coupon at once
      try { return json(p.action === 'redeem' ? redeem_(p.code) : restore_(p.code)); } finally { lock.releaseLock(); }
    }
    return json({ ok: false, error: 'action', message: 'طلب غير معروف' });
  } catch (err) {
    return json({ ok: false, error: 'server', message: String(err && err.message || err) });
  }
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? book.getSheetByName(SHEET_NAME) : book.getSheets()[0];
}

function norm_(v) {
  return String(v == null ? '' : v).trim().toLowerCase()
    .replace(/[ً-ْ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/\s+/g, ' ');
}

function columns_(header) {
  const h = header.map(norm_);
  const out = {};
  Object.keys(HEADERS).forEach(function (key) {
    const names = HEADERS[key].map(norm_);
    out[key] = h.findIndex(function (cell) { return names.indexOf(cell) >= 0; });
  });
  return out;
}

function statusOf_(v) {
  const s = norm_(v);
  if (!s || ['صالح', 'فعال', 'جديد', 'active', 'valid', 'new'].indexOf(s) >= 0) return 'active';
  if (/مستخدم|استخدم|استخدام|مستعمل|used|redeemed|نعم|yes|true|✓|✔/.test(s)) return 'used';
  if (/ملغ|void|cancel|disabled/.test(s)) return 'void';
  return 'active';
}

/** Finds the row for a code; adds the status / date columns if missing. */
function find_(code) {
  const sh = sheet_();
  const values = sh.getDataRange().getDisplayValues();
  let col = columns_(values[0] || []);
  if (col.code < 0) throw new Error('لا يوجد عمود «الكود» في الصف الأول');
  ['status', 'usedAt'].forEach(function (key) {
    if (col[key] < 0) {
      const at = sh.getLastColumn() + 1;
      sh.getRange(1, at).setValue(key === 'status' ? 'الحالة' : 'تاريخ الاستخدام');
      col[key] = at - 1;
    }
  });
  const wanted = String(code || '').trim().toUpperCase();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][col.code]).trim().toUpperCase() === wanted && wanted) {
      return { sh: sh, row: r + 1, col: col, values: values[r] };
    }
  }
  return null;
}

function coupon_(hit) {
  const pick = function (key) { return hit.col[key] >= 0 ? String(hit.values[hit.col[key]] || '') : ''; };
  return {
    code: pick('code'), amount: pick('amount'), status: pick('status'),
    usedAt: pick('usedAt'), note: pick('note'), row: hit.row,
  };
}

function status_(code) {
  const hit = find_(code);
  return hit ? { ok: true, found: true, coupon: coupon_(hit) } : { ok: true, found: false };
}

function redeem_(code) {
  const hit = find_(code);
  if (!hit) return { ok: false, error: 'unknown', message: 'الكود غير موجود في الجدول' };
  const coupon = coupon_(hit);
  const state = statusOf_(coupon.status);
  if (state === 'used') return { ok: false, error: 'used', message: 'الكوبون مستخدم مسبقاً', coupon: coupon };
  if (state === 'void') return { ok: false, error: 'void', message: 'الكوبون ملغى', coupon: coupon };
  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  hit.sh.getRange(hit.row, hit.col.status + 1).setValue('مستخدم');
  hit.sh.getRange(hit.row, hit.col.usedAt + 1).setValue(now);
  coupon.status = 'مستخدم';
  coupon.usedAt = now;
  return { ok: true, coupon: coupon };
}

function restore_(code) {
  const hit = find_(code);
  if (!hit) return { ok: false, error: 'unknown', message: 'الكود غير موجود في الجدول' };
  hit.sh.getRange(hit.row, hit.col.status + 1).setValue('');
  hit.sh.getRange(hit.row, hit.col.usedAt + 1).setValue('');
  const coupon = coupon_(hit);
  coupon.status = '';
  coupon.usedAt = '';
  return { ok: true, coupon: coupon };
}
