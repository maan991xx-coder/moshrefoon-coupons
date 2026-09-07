import crypto from 'node:crypto';
import { config } from './config.js';

// Crockford-style base32 without I, L, O, U — no ambiguity when read or typed by hand.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_GROUPS = 2;      // MSH-XXXX-XXXX
const GROUP_LEN = 4;
const SIG_LEN = 6;          // 30 bits of HMAC — enough to make forgery impractical

/** Random string from ALPHABET using rejection-free modulo-safe bytes. */
function randomChars(n) {
  let out = '';
  while (out.length < n) {
    for (const byte of crypto.randomBytes(n * 2)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue; // avoid modulo bias
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

/** A fresh public coupon code, e.g. "MSH-7K3D-9QF2". */
export function generateCode(prefix = config.prefix) {
  const groups = [];
  for (let i = 0; i < CODE_GROUPS; i++) groups.push(randomChars(GROUP_LEN));
  return `${prefix}-${groups.join('-')}`;
}

/** Short HMAC tag proving the code was minted by this installation. */
export function signCode(code, secret = config.secret) {
  const mac = crypto.createHmac('sha256', secret).update(`coupon:v1:${code}`).digest();
  let bits = 0n;
  for (const byte of mac.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < SIG_LEN; i++) {
    out = ALPHABET[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

/** Constant-time signature check. */
export function verifySignature(code, sig, secret = config.secret) {
  if (typeof sig !== 'string' || sig.length !== SIG_LEN) return false;
  const expected = Buffer.from(signCode(code, secret));
  const given = Buffer.from(sig.toUpperCase());
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Normalise anything a scanner or a human can hand us into { code, sig }.
 * Accepts a full verify URL, "CODE.SIG", a bare code, spaces or lowercase.
 */
export function parseToken(input) {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const fromPath = url.pathname.split('/').filter(Boolean).pop();
      text = url.searchParams.get('c') || decodeURIComponent(fromPath || '');
      const sigParam = url.searchParams.get('s');
      if (sigParam) text += '.' + sigParam;
    } catch {
      return null;
    }
  }

  text = text.toUpperCase().replace(/\s+/g, '');
  const [codePart, sigPart] = text.split('.');
  const code = normaliseCode(codePart);
  if (!code) return null;
  const sig = sigPart && /^[0-9A-Z]{6}$/.test(sigPart) ? sigPart : null;
  return { code, sig };
}

/** "msh 7k3d9qf2" -> "MSH-7K3D-9QF2"; returns null when it cannot be a code. */
export function normaliseCode(input) {
  if (typeof input !== 'string') return null;
  const raw = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const match = raw.match(/^([A-Z0-9]{2,6}?)([0-9A-Z]{8})$/);
  if (!match) return null;
  const [, prefix, body] = match;
  const groups = body.match(/.{4}/g);
  const code = `${prefix}-${groups.join('-')}`;
  return /^[A-Z0-9]{2,6}(-[0-9A-Z]{4}){2}$/.test(code) ? code : null;
}

/** The URL a phone camera opens when it scans the coupon. */
export function tokenUrl(code, sig, baseUrl = config.publicUrl) {
  return `${baseUrl}/v/${code}.${sig}`;
}

export const CODE_ALPHABET = ALPHABET;
