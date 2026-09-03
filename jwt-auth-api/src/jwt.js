import crypto from 'node:crypto';

/**
 * Base64 URL encode
 * @param {Buffer|string} input
 * @returns {string}
 */
export function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Base64 URL decode
 * @param {string} str
 * @returns {Buffer}
 */
export function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

/**
 * Sign a payload to create a JWT token (HS256)
 * @param {object} payload
 * @param {string} secret
 * @param {object} [options] { expiresIn: number (seconds) }
 * @returns {string}
 */
export function signJwt(payload, secret, options = {}) {
  if (!secret) throw new Error('JWT Secret is required');
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Payload must be an object');
  }

  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now
  };

  if (options.expiresIn) {
    fullPayload.exp = now + options.expiresIn;
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest();

  const encodedSignature = base64UrlEncode(signature);
  return `${dataToSign}.${encodedSignature}`;
}

/**
 * Verify and decode a JWT token (HS256)
 * @param {string} token
 * @param {string} secret
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
export function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token is missing or invalid format' };
  }
  if (!secret) {
    return { valid: false, error: 'Secret is required' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Malformed JWT structure' };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  } catch {
    return { valid: false, error: 'Failed to parse JWT header or payload' };
  }

  if (header.alg !== 'HS256') {
    return { valid: false, error: `Unsupported algorithm: ${header.alg}` };
  }

  const dataToSign = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest();

  const providedSignature = base64UrlDecode(encodedSignature);

  if (providedSignature.length !== expectedSignature.length) {
    return { valid: false, error: 'Invalid token signature' };
  }

  if (!crypto.timingSafeEqual(providedSignature, expectedSignature)) {
    return { valid: false, error: 'Invalid token signature' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    return { valid: false, error: 'Token has expired', payload };
  }

  if (payload.nbf && payload.nbf > now) {
    return { valid: false, error: 'Token is not active yet', payload };
  }

  return { valid: true, payload };
}

/**
 * Decode JWT payload without verification
 * @param {string} token
 * @returns {object|null}
 */
export function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
}
