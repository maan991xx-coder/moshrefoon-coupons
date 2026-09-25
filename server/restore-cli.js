/*
 * استعادة نسخة احتياطية | Restore a backup
 *   npm run restore -- moshrefoon-backup-….zip [--dir <data-dir>] [--force]
 * أوقف الخادم أولاً. | Stop the server first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreArchive } from './restore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const dirAt = args.indexOf('--dir');
const dir = dirAt !== -1 ? args[dirAt + 1] : '';
const file = args.find((arg, i) => !arg.startsWith('--') && (dirAt === -1 || i !== dirAt + 1));

if (!file) {
  console.error('الاستخدام | usage: npm run restore -- <backup.zip> [--dir <data-dir>] [--force]');
  process.exit(2);
}

const dataDir = path.resolve(dir || (process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim() || path.join(ROOT, 'data'));
try {
  const restored = restoreArchive(fs.readFileSync(file), dataDir, { force });
  console.log(`تمت الاستعادة إلى ${dataDir}: ${restored.join('، ')}`);
  console.log(`Restored into ${dataDir}. Start the server again.`);
} catch (err) {
  console.error('تعذّرت الاستعادة | restore failed:', err.message);
  process.exit(1);
}
