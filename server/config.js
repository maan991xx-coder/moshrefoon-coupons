import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader: KEY=value lines, `#` comments, optional quotes. */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

/** Read a persisted secret, creating it on first run. */
function persistedSecret(fileName, generate) {
  const file = path.join(dataDir, fileName);
  if (fs.existsSync(file)) {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value) return { value, generated: false };
  }
  const value = generate();
  fs.writeFileSync(file, value + '\n', { mode: 0o600 });
  return { value, generated: true };
}

const secretFromEnv = (process.env.COUPON_SECRET || '').trim();
const secret = secretFromEnv
  ? { value: secretFromEnv, generated: false }
  : persistedSecret('secret.key', () => crypto.randomBytes(32).toString('base64url'));

const passwordFromEnv = (process.env.ADMIN_PASSWORD || '').trim();
const adminPassword = passwordFromEnv
  ? { value: passwordFromEnv, generated: false }
  : persistedSecret('admin-password.txt', () => crypto.randomBytes(9).toString('base64url'));

const exportFromEnv = (process.env.EXPORT_KEY || '').trim();
const exportKey = exportFromEnv
  ? { value: exportFromEnv, generated: false }
  : persistedSecret('export.key', () => crypto.randomBytes(24).toString('base64url'));

const prefix = (process.env.COUPON_PREFIX || 'MSH').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'MSH';

/**
 * Hosting platforms publish the service's real address; use it when PUBLIC_URL
 * is unset so a first deploy never mints QR codes pointing at localhost.
 * Set PUBLIC_URL explicitly once a custom domain is attached — the address is
 * printed into every coupon and cannot be changed after printing.
 */
function platformUrl() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  return '';
}

/** Behind a platform proxy every request arrives from the proxy's address, so
 *  the rate limiter would throttle all staff as one client unless we trust it. */
const behindPlatformProxy = Boolean(
  process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME,
);

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || platformUrl() || `http://localhost:${process.env.PORT || 3000}`)
    .trim().replace(/\/+$/, ''),
  dbPath: path.resolve(ROOT, process.env.DB_PATH || 'data/coupons.db'),
  secret: secret.value,
  secretGenerated: secret.generated,
  adminPassword: adminPassword.value,
  adminPasswordGenerated: adminPassword.generated,
  prefix,
  defaultAmount: (process.env.DEFAULT_AMOUNT || '10').trim(),
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true' || behindPlatformProxy,
  // رابط التصدير للقراءة فقط (Google Sheets) — من يملك الرابط يرى أرقام الكوبونات
  exportKey: exportKey.value,
  exportEnabled: process.env.SHEETS_EXPORT !== '0' && process.env.SHEETS_EXPORT !== 'false',
  // التوقيت المعروض في ملف التصدير | display time zone for the export
  timezone: process.env.DISPLAY_TIMEZONE || 'Asia/Riyadh',
  sessionHours: 12,
  maxBatchSize: 2000,
  dataDir,
};
