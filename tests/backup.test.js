import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moshrefoon-backup-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = path.join(tmpDir, 'volume');
process.env.DB_PATH = path.join(tmpDir, 'volume', 'coupons.db');
process.env.ADMIN_PASSWORD = 'test-password';
process.env.COUPON_SECRET = 'backup-test-secret';
process.env.EXPORT_KEY = 'backup-test-export';
process.env.PUBLIC_URL = 'http://test.local';

const { config } = await import('../server/config.js');
const db = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { buildArchive, runBackup, listBackups, archiveName } = await import('../server/backup.js');
const { restoreArchive } = await import('../server/restore.js');
const { signV4 } = await import('../server/s3.js');
const { createZip, readZip } = await import('../server/zip.js');
const { generateCode, signCode, verifySignature } = await import('../server/codes.js');

db.createBatch({
  quantity: 3, amount: '10', note: 'backup test',
  mint: () => { const code = generateCode(); return { code, sig: signCode(code) }; },
});
const [firstCoupon] = db.listCoupons({ limit: 1 }).rows;
db.redeemCoupon(firstCoupon.code, 'staff');

const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  db.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const settings = (overrides = {}) => ({
  enabled: true,
  dir: fs.mkdtempSync(path.join(tmpDir, 'backups-')),
  intervalHours: 24,
  keep: 14,
  s3: { enabled: false },
  ...overrides,
});

// ---------------------------------------------------------------- archive ---

test('zip round-trips binary and Arabic file names', () => {
  const files = [
    { name: 'a.bin', data: crypto.randomBytes(5000) },
    { name: 'ملاحظة.txt', data: Buffer.from('نص عربي') },
  ];
  const back = readZip(createZip(files));
  assert.deepEqual([...back.keys()], ['a.bin', 'ملاحظة.txt']);
  assert.ok(back.get('a.bin').equals(files[0].data));
  assert.equal(back.get('ملاحظة.txt').toString(), 'نص عربي');
});

test('a corrupted archive is rejected, not half-restored', () => {
  const zip = createZip([{ name: 'x.txt', data: Buffer.from('hello world, hello world') }]);
  zip[40] ^= 0xff;   // inside the compressed payload
  assert.throws(() => readZip(zip));
});

test('the archive carries the database and every key', () => {
  const files = readZip(buildArchive());
  assert.equal(files.get('secret.key').toString().trim(), 'backup-test-secret');
  assert.equal(files.get('export.key').toString().trim(), 'backup-test-export');
  assert.equal(files.get('admin-password.txt').toString().trim(), 'test-password');
  assert.ok(files.get('README.txt').length > 0);

  const copy = path.join(tmpDir, 'copy.db');
  fs.writeFileSync(copy, files.get('coupons.db'));
  const conn = new DatabaseSync(copy);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM coupons').get().n, 3);
  assert.equal(conn.prepare("SELECT status FROM coupons WHERE code = ?").get(firstCoupon.code).status, 'used');
  conn.close();
});

test('backup names sort by time and carry no colons', () => {
  const name = archiveName(new Date('2026-09-25T11:30:05.123Z'));
  assert.equal(name, 'moshrefoon-backup-2026-09-25T11-30-05Z.zip');
  assert.ok(archiveName(new Date('2026-09-26T00:00:00Z')) > name);
});

// ----------------------------------------------------------------- schedule ---

test('runBackup writes to the volume and keeps only the newest copies', async () => {
  const s = settings({ keep: 2 });
  for (let day = 1; day <= 4; day++) {
    const run = await runBackup({ date: new Date(`2026-09-0${day}T03:00:00Z`), settings: s });
    assert.equal(run.error, null);
    assert.equal(run.offsite, 'off');
  }
  const kept = listBackups(s.dir).map((file) => file.name);
  assert.deepEqual(kept, [
    'moshrefoon-backup-2026-09-04T03-00-00Z.zip',
    'moshrefoon-backup-2026-09-03T03-00-00Z.zip',
  ]);
  assert.ok(!fs.readdirSync(s.dir).some((name) => name.endsWith('.part')));
});

test('the default backup folder lives on the Railway volume', () => {
  assert.equal(config.backup.dir, path.join(tmpDir, 'volume', 'backups'));
});

// ------------------------------------------------------------------ restore ---

test('a backup restores into an empty folder and old coupons still verify', () => {
  const target = path.join(tmpDir, 'restored');
  const restored = restoreArchive(buildArchive(), target);
  assert.deepEqual(restored, ['coupons.db', 'secret.key', 'export.key', 'admin-password.txt']);

  const conn = new DatabaseSync(path.join(target, 'coupons.db'));
  const row = conn.prepare('SELECT code, sig FROM coupons WHERE code = ?').get(firstCoupon.code);
  conn.close();
  assert.equal(fs.readFileSync(path.join(target, 'secret.key'), 'utf8').trim(), config.secret);
  assert.ok(verifySignature(row.code, row.sig));
});

test('restore will not overwrite a live database without --force', () => {
  const target = path.join(tmpDir, 'occupied');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'coupons.db'), 'old');
  fs.writeFileSync(path.join(target, 'coupons.db-wal'), 'stale');
  assert.throws(() => restoreArchive(buildArchive(), target), /--force/);

  restoreArchive(buildArchive(), target, { force: true });
  assert.equal(fs.readFileSync(path.join(target, 'coupons.db.before-restore'), 'utf8'), 'old');
  assert.ok(!fs.existsSync(path.join(target, 'coupons.db-wal')));
  assert.ok(fs.existsSync(path.join(target, 'coupons.db-wal.before-restore')));
});

test('restore refuses an archive without the signing key', () => {
  const zip = createZip([{ name: 'coupons.db', data: Buffer.from('x') }]);
  assert.throws(() => restoreArchive(zip, path.join(tmpDir, 'nope')), /مفتاح التوقيع/);
  assert.ok(!fs.existsSync(path.join(tmpDir, 'nope')));
});

test('npm run restore works from the command line', () => {
  const file = path.join(tmpDir, 'cli.zip');
  fs.writeFileSync(file, buildArchive());
  const target = path.join(tmpDir, 'cli-target');
  const output = execFileSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', 'server/restore-cli.js', file, '--dir', target],
    { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.match(output, /Restored/);
  assert.ok(fs.existsSync(path.join(target, 'coupons.db')));
  assert.ok(!fs.existsSync(path.join(target, 'export.key.before-restore')), 'CLI must not mint keys of its own');
});

// ------------------------------------------------------------------ off-site ---

test('SigV4 matches the AWS documented example', () => {
  const headers = {
    host: 'examplebucket.s3.amazonaws.com',
    range: 'bytes=0-9',
    'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'x-amz-date': '20130524T000000Z',
  };
  const auth = signV4({
    method: 'GET', path: '/test.txt', headers, payloadHash: headers['x-amz-content-sha256'],
    region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });
  assert.match(auth, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

/** A stand-in bucket that checks the signature the way S3 would. */
function fakeBucket(status = 200) {
  const received = [];
  const bucket = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const signed = /SignedHeaders=([^,]+)/.exec(req.headers.authorization)[1].split(';');
      const headers = Object.fromEntries(signed.map((name) => [name, req.headers[name]]));
      const expected = signV4({
        method: req.method, path: req.url, headers, payloadHash: req.headers['x-amz-content-sha256'],
        region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK',
      });
      received.push({
        url: req.url, body,
        signatureOk: expected === req.headers.authorization,
        hashOk: crypto.createHash('sha256').update(body).digest('hex') === req.headers['x-amz-content-sha256'],
      });
      res.writeHead(status).end(status === 200 ? '' : '<Error>AccessDenied</Error>');
    });
  }).listen(0);
  return { bucket, received, endpoint: `http://127.0.0.1:${bucket.address().port}` };
}

test('a configured bucket receives a signed copy of every backup', async () => {
  const { bucket, received, endpoint } = fakeBucket();
  try {
    const s = settings({ s3: { enabled: true, endpoint, bucket: 'coupons', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK', prefix: 'moshrefoon-backups' } });
    const run = await runBackup({ date: new Date('2026-09-25T03:00:00Z'), settings: s });
    assert.equal(run.offsite, 'ok');
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/coupons/moshrefoon-backups/moshrefoon-backup-2026-09-25T03-00-00Z.zip');
    assert.ok(received[0].signatureOk, 'signature must verify');
    assert.ok(received[0].hashOk, 'payload hash must match');
    assert.ok(received[0].body.equals(fs.readFileSync(path.join(s.dir, run.file))));
  } finally {
    bucket.close();
  }
});

test('a failing bucket is reported but the local backup still lands', async () => {
  const { bucket, endpoint } = fakeBucket(403);
  try {
    const s = settings({ s3: { enabled: true, endpoint, bucket: 'coupons', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK', prefix: '' } });
    const run = await runBackup({ settings: s });
    assert.equal(run.offsite, 'failed');
    assert.match(run.error, /403/);
    assert.equal(listBackups(s.dir).length, 1);
  } finally {
    bucket.close();
  }
});

// ---------------------------------------------------------------------- API ---

test('downloading a backup needs a session', async () => {
  assert.equal((await fetch(base + '/api/backup')).status, 401);
  assert.equal((await fetch(base + '/api/backups')).status, 401);
});

test('a signed-in user downloads a fresh, restorable backup', async () => {
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const response = await fetch(base + '/api/backup', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /moshrefoon-backup-.*\.zip/);
  const files = readZip(Buffer.from(await response.arrayBuffer()));
  assert.equal(files.get('secret.key').toString().trim(), 'backup-test-secret');

  const info = await (await fetch(base + '/api/backups', { headers: { Cookie: cookie } })).json();
  assert.equal(info.enabled, true);
  assert.equal(info.intervalHours, 24);
  assert.equal(info.offsite, false);
  assert.ok(Array.isArray(info.files));
});
