import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readZip } from './zip.js';

// Deliberately free of config.js: importing config creates fresh keys in the
// data directory, which is the last thing a restore wants.

export const DB_FILE = 'coupons.db';

/**
 * Unpack a backup into `dataDir`. Refuses to overwrite an existing database
 * unless `force` is set; the replaced files are kept beside it as *.before-restore.
 */
export function restoreArchive(buffer, dataDir, { force = false } = {}) {
  const files = readZip(buffer);
  const dbData = files.get(DB_FILE);
  if (!dbData || !files.get('secret.key')) throw new Error('الملف لا يحوي قاعدة البيانات ومفتاح التوقيع');

  // Prove the database opens before touching anything on disk.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coupons-restore-'));
  try {
    fs.writeFileSync(path.join(probeDir, DB_FILE), dbData);
    const probe = new DatabaseSync(path.join(probeDir, DB_FILE));
    const check = probe.prepare('PRAGMA integrity_check').get();
    probe.prepare('SELECT COUNT(*) FROM coupons').get();
    probe.close();
    if (Object.values(check)[0] !== 'ok') throw new Error('قاعدة البيانات في النسخة تالفة');
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, DB_FILE);
  if (fs.existsSync(target) && !force) {
    throw new Error(`توجد قاعدة بيانات في ${target} — أضف --force لاستبدالها`);
  }
  const restored = [];
  for (const name of [DB_FILE, 'secret.key', 'export.key', 'admin-password.txt']) {
    const data = files.get(name);
    if (!data) continue;
    const dest = path.join(dataDir, name);
    if (fs.existsSync(dest)) fs.renameSync(dest, dest + '.before-restore');
    fs.writeFileSync(dest, data, { mode: 0o600 });
    restored.push(name);
  }
  // A WAL left by the old database would be replayed onto the restored one.
  for (const suffix of ['-wal', '-shm']) {
    const stale = target + suffix;
    if (fs.existsSync(stale)) fs.renameSync(stale, stale + '.before-restore');
  }
  return restored;
}
