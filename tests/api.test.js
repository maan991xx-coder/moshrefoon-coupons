import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moshrefoon-coupons-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.ADMIN_PASSWORD = 'test-password';
process.env.COUPON_SECRET = 'test-secret-key';
process.env.PUBLIC_URL = 'http://test.local';
process.env.COUPON_PREFIX = 'MSH';

const { createApp } = await import('../server/app.js');
const { closeDb, getDb } = await import('../server/db.js');
const { signCode, parseToken, normaliseCode, verifySignature } = await import('../server/codes.js');

const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '';

async function call(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.anonymous ? {} : { Cookie: cookie }),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'manual',
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, body: json, headers: response.headers };
}

test.after(() => {
  server.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --------------------------------------------------------------- unit tests --

test('normaliseCode accepts human typing', () => {
  assert.equal(normaliseCode('msh 7k3d 9qf2'), 'MSH-7K3D-9QF2');
  assert.equal(normaliseCode('MSH-7K3D-9QF2'), 'MSH-7K3D-9QF2');
  assert.equal(normaliseCode('nonsense'), null);
});

test('parseToken understands scanned URLs', () => {
  assert.deepEqual(parseToken('http://test.local/v/MSH-7K3D-9QF2.ABC123'), { code: 'MSH-7K3D-9QF2', sig: 'ABC123' });
  assert.deepEqual(parseToken('MSH-7K3D-9QF2'), { code: 'MSH-7K3D-9QF2', sig: null });
  assert.equal(parseToken('   '), null);
});

test('signatures are deterministic and tamper-evident', () => {
  const sig = signCode('MSH-7K3D-9QF2');
  assert.equal(sig, signCode('MSH-7K3D-9QF2'));
  assert.ok(verifySignature('MSH-7K3D-9QF2', sig));
  assert.equal(verifySignature('MSH-7K3D-9QF3', sig), false);
  assert.equal(verifySignature('MSH-7K3D-9QF2', 'ZZZZZZ'), false);
});

// ---------------------------------------------------------------- API tests --

test('admin endpoints require a session', async () => {
  const denied = await call('/api/batches', { method: 'POST', body: { quantity: 1 }, anonymous: true });
  assert.equal(denied.status, 401);
});

test('login rejects the wrong password', async () => {
  const bad = await call('/api/login', { method: 'POST', body: { password: 'nope' }, anonymous: true });
  assert.equal(bad.status, 401);
});

test('login issues a session cookie', async () => {
  const response = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.getSetCookie()[0].split(';')[0];
  assert.match(cookie, /^msh_session=/);
});

let batchRef = '';
let coupons = [];

test('generating a batch mints the requested number of unique signed codes', async () => {
  const { status, body } = await call('/api/batches', {
    method: 'POST',
    body: { quantity: 10, amount: '10', note: 'دفعة اختبار' },
  });
  assert.equal(status, 201);
  assert.equal(body.coupons.length, 10);
  batchRef = body.batch.ref;
  coupons = body.coupons;

  assert.equal(new Set(coupons.map((c) => c.code)).size, 10);
  for (const coupon of coupons) {
    assert.match(coupon.code, /^MSH-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.ok(verifySignature(coupon.code, coupon.sig));
    assert.equal(coupon.url, `http://test.local/v/${coupon.code}.${coupon.sig}`);
    assert.ok(coupon.qr.size >= 21);
    assert.equal(coupon.qr.modules.length, coupon.qr.size ** 2);
  }
});

test('rejects an out-of-range quantity', async () => {
  assert.equal((await call('/api/batches', { method: 'POST', body: { quantity: 0 } })).status, 400);
  assert.equal((await call('/api/batches', { method: 'POST', body: { quantity: 99999 } })).status, 400);
});

test('a freshly minted coupon verifies as valid', async () => {
  const coupon = coupons[0];
  const { body } = await call(`/api/verify?token=${coupon.code}.${coupon.sig}`);
  assert.equal(body.result, 'valid');
  assert.equal(body.signatureOk, true);
  assert.equal(body.canRedeem, true);
});

test('anonymous verification never leaks the signature or QR', async () => {
  const coupon = coupons[1];
  const { body } = await call(`/api/verify?token=${coupon.code}.${coupon.sig}`, { anonymous: true });
  assert.equal(body.result, 'valid');
  assert.equal(body.canRedeem, false);
  assert.equal(body.coupon.sig, undefined);
  assert.equal(body.coupon.url, undefined);
  assert.equal(body.coupon.qr, undefined);
  assert.equal(body.coupon.code, coupon.code);
});

test('a code that was never issued here is unknown', async () => {
  const { body } = await call('/api/verify?token=MSH-0000-0000');
  assert.equal(body.result, 'unknown');
  assert.equal(body.coupon, null);
});

test('a wrong signature is reported as forged and reveals nothing', async () => {
  const { body } = await call(`/api/verify?token=${coupons[2].code}.ZZZZZZ`);
  assert.equal(body.result, 'forged');
  assert.equal(body.signatureOk, false);
  assert.equal(body.coupon, null);
});

test('malformed input is rejected', async () => {
  const { status, body } = await call('/api/verify?token=hello');
  assert.equal(status, 400);
  assert.equal(body.result, 'malformed');
});

test('redeeming marks the coupon used exactly once', async () => {
  const coupon = coupons[0];
  const first = await call(`/api/coupons/${coupon.code}/redeem`, { method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(first.body.coupon.status, 'used');
  assert.ok(first.body.coupon.usedAt);

  const second = await call(`/api/coupons/${coupon.code}/redeem`, { method: 'POST' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'already_used');

  const { body } = await call(`/api/verify?token=${coupon.code}.${coupon.sig}`);
  assert.equal(body.result, 'used');
});

test('a redemption can be undone', async () => {
  const coupon = coupons[0];
  const restored = await call(`/api/coupons/${coupon.code}/restore`, { method: 'POST' });
  assert.equal(restored.body.coupon.status, 'active');
  assert.equal(restored.body.coupon.usedAt, null);
});

test('voided coupons stop verifying', async () => {
  const coupon = coupons[3];
  await call(`/api/coupons/${coupon.code}/void`, { method: 'POST', body: { void: true } });
  const { body } = await call(`/api/verify?token=${coupon.code}.${coupon.sig}`);
  assert.equal(body.result, 'void');
  await call(`/api/coupons/${coupon.code}/void`, { method: 'POST', body: { void: false } });
  assert.equal((await call(`/api/verify?token=${coupon.code}`)).body.result, 'valid');
});

test('expired coupons are reported as expired and cannot be redeemed', async () => {
  const { body } = await call('/api/batches', {
    method: 'POST',
    body: { quantity: 1, amount: '10', expiresAt: '2020-01-01' },
  });
  const coupon = body.coupons[0];
  const verdict = await call(`/api/verify?token=${coupon.code}.${coupon.sig}`);
  assert.equal(verdict.body.result, 'expired');
  const redeem = await call(`/api/coupons/${coupon.code}/redeem`, { method: 'POST' });
  assert.equal(redeem.status, 409);
  assert.equal(redeem.body.error, 'expired');
});

test('listing filters by status and batch', async () => {
  const all = await call(`/api/coupons?batch=${batchRef}`);
  assert.equal(all.body.total, 10);
  const active = await call(`/api/coupons?batch=${batchRef}&status=active`);
  assert.ok(active.body.total <= 10);
  const search = await call(`/api/coupons?q=${coupons[5].code}`);
  assert.equal(search.body.total, 1);
});

test('every verification is written to the audit log', async () => {
  const { body } = await call(`/api/coupons/${coupons[0].code}`);
  assert.ok(body.scans.length > 0);
  assert.ok(body.scans.some((scan) => scan.action === 'redeem'));
});

test('CSV export lists the batch', async () => {
  const response = await fetch(`${base}/api/batches/${batchRef}/export.csv`, { headers: { Cookie: cookie } });
  const text = await response.text();
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.ok(text.includes(coupons[4].code));
  assert.equal(text.trim().split('\n').length, 11); // header + 10 coupons
});

test('QR endpoints return real images', async () => {
  const png = await fetch(`${base}/api/coupons/${coupons[6].code}/qr.png`, { headers: { Cookie: cookie } });
  const buffer = Buffer.from(await png.arrayBuffer());
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual(buffer.subarray(1, 4).toString(), 'PNG');

  const svg = await fetch(`${base}/api/coupons/${coupons[6].code}/qr.svg`, { headers: { Cookie: cookie } });
  assert.match(await svg.text(), /<svg/);
});

test('the public verify page is reachable without a session', async () => {
  const response = await fetch(`${base}/v/${coupons[7].code}.${coupons[7].sig}`, { redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /كشف كوبون/);
});

test('unauthenticated dashboard access redirects to login', async () => {
  const response = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/login/);
});

test('database survives a reopen with the same codes', async () => {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM coupons').get();
  assert.equal(row.count, 11);
});
