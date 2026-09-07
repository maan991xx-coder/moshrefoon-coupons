import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ref         TEXT    NOT NULL UNIQUE,
  quantity    INTEGER NOT NULL,
  amount      TEXT    NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  expires_at  TEXT,
  created_at  TEXT    NOT NULL,
  created_by  TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS coupons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  sig         TEXT    NOT NULL,
  batch_id    INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  amount      TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active',   -- active | used | void
  created_at  TEXT    NOT NULL,
  expires_at  TEXT,
  used_at     TEXT,
  used_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_coupons_batch  ON coupons(batch_id);
CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status);

CREATE TABLE IF NOT EXISTS scans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL,
  result      TEXT    NOT NULL,
  action      TEXT    NOT NULL DEFAULT 'verify',   -- verify | redeem | restore | void
  at          TEXT    NOT NULL,
  ip          TEXT    NOT NULL DEFAULT '',
  actor       TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_scans_code ON scans(code);
CREATE INDEX IF NOT EXISTS idx_scans_at   ON scans(at);
`;

let db;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = undefined; }
}

const nowIso = () => new Date().toISOString();

/** Next batch reference, e.g. "B-2026-0007". */
function nextBatchRef(conn) {
  const year = new Date().getFullYear();
  const prefix = `B-${year}-`;
  const row = conn.prepare('SELECT ref FROM batches WHERE ref LIKE ? ORDER BY id DESC LIMIT 1').get(prefix + '%');
  const last = row ? Number(String(row.ref).slice(prefix.length)) : 0;
  return prefix + String(last + 1).padStart(4, '0');
}

/**
 * Create a batch plus its coupons in one transaction.
 * `mint()` must return { code, sig } and is retried on the (astronomically
 * unlikely) event of a code collision.
 */
export function createBatch({ quantity, amount, note = '', expiresAt = null, createdBy = '', mint }) {
  const conn = getDb();
  const created = nowIso();
  const insertBatch = conn.prepare(
    'INSERT INTO batches (ref, quantity, amount, note, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertCoupon = conn.prepare(
    'INSERT INTO coupons (code, sig, batch_id, amount, status, created_at, expires_at) VALUES (?, ?, ?, ?, \'active\', ?, ?)',
  );

  conn.exec('BEGIN IMMEDIATE');
  try {
    const ref = nextBatchRef(conn);
    const batchId = Number(insertBatch.run(ref, quantity, amount, note, expiresAt, created, createdBy).lastInsertRowid);
    const coupons = [];
    for (let i = 0; i < quantity; i++) {
      let inserted = false;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const { code, sig } = mint();
        try {
          insertCoupon.run(code, sig, batchId, amount, created, expiresAt);
          coupons.push({ code, sig, amount, status: 'active', created_at: created, expires_at: expiresAt });
          inserted = true;
        } catch (err) {
          if (!String(err.message).includes('UNIQUE')) throw err;
        }
      }
      if (!inserted) throw new Error('تعذّر توليد كود فريد بعد عدة محاولات');
    }
    conn.exec('COMMIT');
    return { batch: getBatch(ref), coupons };
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

export function getBatch(ref) {
  return getDb().prepare(`
    SELECT b.*,
           (SELECT COUNT(*) FROM coupons c WHERE c.batch_id = b.id)                        AS total,
           (SELECT COUNT(*) FROM coupons c WHERE c.batch_id = b.id AND c.status = 'used')  AS used,
           (SELECT COUNT(*) FROM coupons c WHERE c.batch_id = b.id AND c.status = 'void')  AS voided
    FROM batches b WHERE b.ref = ?`).get(ref);
}

export function listBatches(limit = 100) {
  return getDb().prepare(`
    SELECT b.*,
           (SELECT COUNT(*) FROM coupons c WHERE c.batch_id = b.id)                        AS total,
           (SELECT COUNT(*) FROM coupons c WHERE c.batch_id = b.id AND c.status = 'used')  AS used,
           (SELECT COUNT(*) FROM coupons c WHERE c.batch_id = b.id AND c.status = 'void')  AS voided
    FROM batches b ORDER BY b.id DESC LIMIT ?`).all(limit);
}

export function getCoupon(code) {
  return getDb().prepare(`
    SELECT c.*, b.ref AS batch_ref, b.note AS batch_note
    FROM coupons c JOIN batches b ON b.id = c.batch_id
    WHERE c.code = ?`).get(code);
}

export function listCoupons({ status = '', batchRef = '', search = '', limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (batchRef) { where.push('b.ref = ?'); params.push(batchRef); }
  if (search) { where.push('c.code LIKE ?'); params.push('%' + search.toUpperCase() + '%'); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const conn = getDb();
  const rows = conn.prepare(`
    SELECT c.*, b.ref AS batch_ref FROM coupons c JOIN batches b ON b.id = c.batch_id
    ${clause} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const { count } = conn.prepare(`
    SELECT COUNT(*) AS count FROM coupons c JOIN batches b ON b.id = c.batch_id ${clause}`).get(...params);
  return { rows, total: count };
}

/** Mark a coupon used. Returns { ok, coupon, reason }. */
export function redeemCoupon(code, actor = '') {
  const conn = getDb();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const coupon = conn.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
    if (!coupon) { conn.exec('ROLLBACK'); return { ok: false, reason: 'unknown' }; }
    if (coupon.status === 'used') { conn.exec('ROLLBACK'); return { ok: false, reason: 'already_used', coupon }; }
    if (coupon.status === 'void') { conn.exec('ROLLBACK'); return { ok: false, reason: 'void', coupon }; }
    conn.prepare("UPDATE coupons SET status = 'used', used_at = ?, used_by = ? WHERE id = ?")
      .run(nowIso(), actor, coupon.id);
    conn.exec('COMMIT');
    return { ok: true, coupon: getCoupon(code) };
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/** Undo a redemption (mistaken scan). */
export function restoreCoupon(code) {
  const conn = getDb();
  const coupon = getCoupon(code);
  if (!coupon) return { ok: false, reason: 'unknown' };
  conn.prepare("UPDATE coupons SET status = 'active', used_at = NULL, used_by = NULL WHERE code = ?").run(code);
  return { ok: true, coupon: getCoupon(code) };
}

/** Cancel a coupon permanently (lost sheet, printing error). */
export function setVoid(code, voided = true) {
  const conn = getDb();
  const coupon = getCoupon(code);
  if (!coupon) return { ok: false, reason: 'unknown' };
  if (coupon.status === 'used' && voided) return { ok: false, reason: 'already_used', coupon };
  conn.prepare('UPDATE coupons SET status = ? WHERE code = ?').run(voided ? 'void' : 'active', code);
  return { ok: true, coupon: getCoupon(code) };
}

export function logScan({ code, result, action = 'verify', ip = '', actor = '' }) {
  getDb().prepare('INSERT INTO scans (code, result, action, at, ip, actor) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, result, action, nowIso(), ip, actor);
}

export function listScans(code, limit = 20) {
  return getDb().prepare('SELECT * FROM scans WHERE code = ? ORDER BY id DESC LIMIT ?').all(code, limit);
}

export function recentScans(limit = 30) {
  return getDb().prepare('SELECT * FROM scans ORDER BY id DESC LIMIT ?').all(limit);
}

export function stats() {
  const conn = getDb();
  const one = (sql) => Object.values(conn.prepare(sql).get())[0];
  return {
    total: one('SELECT COUNT(*) FROM coupons'),
    active: one("SELECT COUNT(*) FROM coupons WHERE status = 'active'"),
    used: one("SELECT COUNT(*) FROM coupons WHERE status = 'used'"),
    voided: one("SELECT COUNT(*) FROM coupons WHERE status = 'void'"),
    batches: one('SELECT COUNT(*) FROM batches'),
    scansToday: conn.prepare('SELECT COUNT(*) AS c FROM scans WHERE at >= ?')
      .get(new Date(new Date().toDateString()).toISOString()).c,
  };
}
