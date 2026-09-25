import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';
import { DB_FILE } from './restore.js';
import { putObject } from './s3.js';
import { createZip } from './zip.js';

/*
 * النسخة الاحتياطية ملف ZIP واحد فيه كل ما يلزم لإعادة الموقع كما كان:
 * قاعدة البيانات ومفتاح التوقيع ومفتاح التصدير وكلمة المرور.
 * فكّه داخل مجلد البيانات (أو الحجم الدائم) فيعود كل شيء وتبقى الكوبونات المطبوعة صالحة.
 *
 * One ZIP holds everything that must survive: the database plus every key.
 * Unzipped into the data directory it brings the site back exactly, and every
 * printed coupon still verifies because the signing key comes with it.
 */

const PREFIX = 'moshrefoon-backup-';

const README = `نسخة احتياطية لموقع كوبونات المشرفون
Moshrefoon coupons backup

coupons.db          قاعدة البيانات | the database
secret.key          مفتاح توقيع QR — بدونه لا تُقبل الكوبونات المطبوعة | QR signing key
export.key          مفتاح رابط Google Sheets | Sheets export key
admin-password.txt  كلمة مرور لوحة التحكم | dashboard password

الاستعادة | Restore:
  npm run restore -- <this-file>.zip
أو فكّ الملفات يدوياً داخل مجلد data/ (أو الحجم الدائم) والخادم متوقف.
or unzip into data/ (or the volume) while the server is stopped.

احفظ هذا الملف في مكان آمن: من يملكه يستطيع توقيع كوبونات.
Keep this file private: whoever has it can sign coupons.
`;

/** A consistent copy of the live database, taken without stopping writes. */
export function snapshotDatabase() {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coupons-snap-')), DB_FILE);
  try {
    getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    return fs.readFileSync(tmp);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

/** The whole backup as one ZIP buffer. */
export function buildArchive(date = new Date()) {
  return createZip([
    { name: DB_FILE, data: snapshotDatabase() },
    { name: 'secret.key', data: Buffer.from(config.secret + '\n') },
    { name: 'export.key', data: Buffer.from(config.exportKey + '\n') },
    { name: 'admin-password.txt', data: Buffer.from(config.adminPassword + '\n') },
    { name: 'README.txt', data: Buffer.from(README) },
  ], date);
}

/** "moshrefoon-backup-2026-09-25T11-30-00Z.zip" — sorts by time. */
export function archiveName(date = new Date()) {
  return PREFIX + date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-') + '.zip';
}

/** Local backups, newest first. */
export function listBackups(dir = config.backup.dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(PREFIX) && name.endsWith('.zip'))
    .sort().reverse()
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, at: stat.mtime.toISOString() };
    });
}

function prune(dir, keep) {
  for (const old of listBackups(dir).slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });
}

let lastRun = null;
export const lastBackup = () => lastRun;

/**
 * Write a backup to the volume, keep the newest `keep`, and copy it off-site
 * when a bucket is configured. Never throws: a failed backup must not take the
 * coupon site down with it.
 */
export async function runBackup({ date = new Date(), settings = config.backup } = {}) {
  const run = { at: date.toISOString(), file: null, size: 0, offsite: settings.s3.enabled ? 'pending' : 'off', error: null };
  try {
    const archive = buildArchive(date);
    const name = archiveName(date);
    fs.mkdirSync(settings.dir, { recursive: true, mode: 0o700 });
    const file = path.join(settings.dir, name);
    fs.writeFileSync(file + '.part', archive, { mode: 0o600 });
    fs.renameSync(file + '.part', file);
    prune(settings.dir, settings.keep);
    run.file = name;
    run.size = archive.length;

    if (settings.s3.enabled) {
      try {
        await putObject(settings.s3, `${settings.s3.prefix ? settings.s3.prefix + '/' : ''}${name}`, archive, 'application/zip');
        run.offsite = 'ok';
      } catch (err) {
        run.offsite = 'failed';
        run.error = err.message;
      }
    }
  } catch (err) {
    run.error = err.message;
  }
  lastRun = run;
  if (run.error) console.error('[backup]', run.error);
  else console.log(`[backup] ${run.file} (${Math.round(run.size / 1024)} KB)${run.offsite === 'ok' ? ' + off-site copy' : ''}`);
  return run;
}

/**
 * Back up shortly after start (so every deploy leaves a copy) and then every
 * `intervalHours`. Returns a stop function.
 */
export function startBackupSchedule({ firstDelayMs = 60_000 } = {}) {
  if (!config.backup.enabled) return () => {};
  const first = setTimeout(() => runBackup(), firstDelayMs);
  const every = setInterval(() => runBackup(), config.backup.intervalHours * 3_600_000);
  first.unref(); every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
