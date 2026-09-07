import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'msh_session';

function sign(value) {
  return crypto.createHmac('sha256', config.secret).update(value).digest('base64url');
}

/** Opaque, tamper-proof session token: "<expiry>.<user>.<hmac>". */
export function issueToken(user = 'staff') {
  const expiry = Date.now() + config.sessionHours * 3600_000;
  const payload = `${expiry}.${Buffer.from(user).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

export function readToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [expiry, user, mac] = parts;
  const expected = Buffer.from(sign(`${expiry}.${user}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (!Number(expiry) || Number(expiry) < Date.now()) return null;
  return { user: Buffer.from(user, 'base64url').toString('utf8'), expiry: Number(expiry) };
}

export function checkPassword(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(config.adminPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Populates req.session (or null) for every request. */
export function sessionMiddleware(req, _res, next) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  req.session = readToken(raw);
  next();
}

export function requireAuth(req, res, next) {
  if (req.session) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorised', message: 'يلزم تسجيل الدخول' });
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

export function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionHours * 3600}`,
  ];
  if (config.publicUrl.startsWith('https://')) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Fixed-window limiter, enough for a single-node deployment. */
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
    } else if (++entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'rate_limited', message: 'محاولات كثيرة، انتظر قليلاً ثم أعد المحاولة' });
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    next();
  };
}
