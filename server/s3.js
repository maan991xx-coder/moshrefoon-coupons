import crypto from 'node:crypto';

/* رفع ملف إلى أي تخزين متوافق مع S3 (Railway Buckets، Cloudflare R2، Backblaze B2، AWS)
   Minimal AWS Signature V4 PUT, so the backup can leave the volume without an SDK. */

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it; `/` kept in object keys. */
function encodePath(path) {
  return path.split('/').map((part) => encodeURIComponent(part)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

/**
 * The Authorization header for one request.
 * `headers` must already hold every header to sign (host, x-amz-date,
 * x-amz-content-sha256, …), with lower-case names.
 */
export function signV4({ method, path, query = '', headers, payloadHash, region, accessKeyId, secretAccessKey, service = 's3' }) {
  const amzDate = headers['x-amz-date'];
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * PUT `body` at `key` inside the bucket (path-style addressing, which every
 * S3-compatible provider accepts).
 */
export async function putObject({ endpoint, bucket, region, accessKeyId, secretAccessKey }, key, body, contentType = 'application/octet-stream') {
  const base = new URL(endpoint);
  const prefix = base.pathname.replace(/\/+$/, '');
  const path = encodePath(`${prefix}/${bucket}/${key}`);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = sha256(body);
  const headers = {
    host: base.host,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const authorization = signV4({ method: 'PUT', path, headers, payloadHash, region, accessKeyId, secretAccessKey });
  const { host, ...sent } = headers;
  const response = await fetch(`${base.protocol}//${base.host}${path}`, {
    method: 'PUT',
    headers: { ...sent, authorization },
    body,
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new Error(`S3 PUT ${response.status}: ${text}`);
  }
}
