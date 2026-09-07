import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = "import('./server/config.js').then((m) => console.log(JSON.stringify("
  + '{ url: m.config.publicUrl, trustProxy: m.config.trustProxy })))';

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
