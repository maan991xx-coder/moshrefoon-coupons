import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = "import('./server/config.js').then((m) => console.log(JSON.stringify("
  + '{ url: m.config.publicUrl, trustProxy: m.config.trustProxy,'
  + ' dbPath: m.config.dbPath, dataDir: m.config.dataDir })))';

/** config.js reads the environment once at import, so each case needs its own process. */
function loadConfig(env) {
  const output = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      COUPON_SECRET: 'test-secret',
      ADMIN_PASSWORD: 'test-password',
      ...env,
    },
  });
  return JSON.parse(output);
}

test('falls back to localhost when nothing is configured', () => {
  const config = loadConfig({ PORT: '4321' });
  assert.equal(config.url, 'http://localhost:4321');
  assert.equal(config.trustProxy, false);
});

test('uses the address Railway publishes, and trusts its proxy', () => {
  const config = loadConfig({
    RAILWAY_PUBLIC_DOMAIN: 'coupons-production.up.railway.app',
    RAILWAY_ENVIRONMENT: 'production',
  });
  assert.equal(config.url, 'https://coupons-production.up.railway.app');
  assert.equal(config.trustProxy, true);
});

test('uses the address Render and Fly publish', () => {
  assert.equal(loadConfig({ RENDER_EXTERNAL_URL: 'https://coupons.onrender.com', RENDER: 'true' }).url,
    'https://coupons.onrender.com');
  assert.equal(loadConfig({ FLY_APP_NAME: 'moshrefoon-coupons' }).url,
    'https://moshrefoon-coupons.fly.dev');
});

test('an explicit PUBLIC_URL always wins, trailing slash trimmed', () => {
  const config = loadConfig({
    PUBLIC_URL: 'https://coupons.example.com/',
    RAILWAY_PUBLIC_DOMAIN: 'ignored.up.railway.app',
  });
  assert.equal(config.url, 'https://coupons.example.com');
});

test('a mounted volume holds the database and every generated key', () => {
  const volume = fs.mkdtempSync(path.join(os.tmpdir(), 'coupon-volume-'));
  try {
    const config = loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: volume });
    assert.equal(config.dataDir, volume);
    assert.equal(config.dbPath, path.join(volume, 'coupons.db'));
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test('an explicit DB_PATH still wins over the volume', () => {
  const volume = fs.mkdtempSync(path.join(os.tmpdir(), 'coupon-volume-'));
  try {
    const config = loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: volume, DB_PATH: '/srv/coupons/live.db' });
    assert.equal(config.dbPath, '/srv/coupons/live.db');
    assert.equal(config.dataDir, volume);
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test('without a volume the app keeps its state beside the code', () => {
  const config = loadConfig({});
  assert.equal(config.dataDir, path.join(ROOT, 'data'));
  assert.equal(config.dbPath, path.join(ROOT, 'data', 'coupons.db'));
});
