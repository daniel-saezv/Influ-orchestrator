import { AwsV4Signer } from 'aws4fetch';
import { err } from '../../core/domain/errors.js';

export const PRESIGN_TTL_SECONDS = 600;
const SIGNING_ENV = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_BUCKET_NAME'];

function readSigningEnv(env) {
  const values = {};
  const missing = [];
  for (const name of SIGNING_ENV) {
    const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
    if (!value) missing.push(name);
    else values[name] = value;
  }
  return { values, missing };
}

export function signingUnavailableError(env) {
  const { missing } = readSigningEnv(env);
  const names = (missing.length ? missing : SIGNING_ENV).join(', ');
  return err('R2_SIGNING_UNAVAILABLE', `Faltan las credenciales para firmar el acceso a R2: ${names}`, 503);
}

function objectUrl(cfg, key, ttlSeconds) {
  const encoded = key.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${encoded}?X-Amz-Expires=${ttlSeconds}`;
}

function assertTtl(ttlSeconds) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 604800) {
    throw err('INVALID_INPUT', 'La caducidad de la firma no es válida', 400);
  }
}

function assertKey(key, { put }) {
  const prefixOk = put ? key.startsWith('out/') : key.startsWith('pending/') || key.startsWith('src/') || key.startsWith('out/');
  if (typeof key !== 'string' || key.length < 5 || key.length > 200 || !prefixOk
    || /\s/.test(key) || key.includes('..') || key.includes('\\') || key.includes('?') || key.includes('#') || key.startsWith('/')) {
    throw err('INVALID_INPUT', 'Clave de objeto no válida', 400);
  }
}

class LengthHeaders extends Headers {
  constructor(init) {
    let length;
    let source = init;
    if (init && typeof init === 'object' && !Array.isArray(init) && typeof init.append !== 'function') {
      source = { ...init };
      for (const key of Object.keys(source)) {
        if (key.toLowerCase() === 'content-length') {
          length = source[key];
          delete source[key];
        }
      }
    }
    super(source);
    if (length != null) this.contentLength = String(length);
  }

  get(name) {
    if (String(name).toLowerCase() === 'content-length' && this.contentLength != null) return this.contentLength;
    return super.get(name);
  }

  has(name) {
    if (String(name).toLowerCase() === 'content-length' && this.contentLength != null) return true;
    return super.has(name);
  }

  keys() {
    const names = [...super.keys()];
    if (this.contentLength != null && !names.includes('content-length')) names.push('content-length');
    return names[Symbol.iterator]();
  }
}

async function sign(cfg, { method, key, headers, ttlSeconds, allHeaders }) {
  assertTtl(ttlSeconds);
  const RealHeaders = globalThis.Headers;
  globalThis.Headers = LengthHeaders;
  let signer;
  try {
    signer = new AwsV4Signer({
      url: objectUrl(cfg, key, ttlSeconds),
      method,
      headers,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: 'auto',
      signQuery: true,
      allHeaders,
    });
  } finally {
    globalThis.Headers = RealHeaders;
  }
  const signed = await signer.sign();
  return signed.url.toString();
}

export function signerFromEnv(env) {
  const { values, missing } = readSigningEnv(env);
  if (missing.length) return null;
  return createR2Signer({
    accessKeyId: values.R2_ACCESS_KEY_ID,
    secretAccessKey: values.R2_SECRET_ACCESS_KEY,
    accountId: values.R2_ACCOUNT_ID,
    bucket: values.R2_BUCKET_NAME,
  });
}

export function createR2Signer(cfg) {
  return {
    async signGet(key, ttlSeconds = PRESIGN_TTL_SECONDS) {
      assertKey(key, { put: false });
      return sign(cfg, { method: 'GET', key, ttlSeconds, allHeaders: false });
    },
    async signPut(key, headers, ttlSeconds = PRESIGN_TTL_SECONDS) {
      assertKey(key, { put: true });
      return sign(cfg, { method: 'PUT', key, headers, ttlSeconds, allHeaders: true });
    },
  };
}
