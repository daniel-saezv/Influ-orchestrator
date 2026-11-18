// Validación opcional de Cf-Access-Jwt-Assertion (segunda capa tras Cloudflare Access en el edge).
// Activa solo si ACCESS_TEAM_DOMAIN y ACCESS_AUD están definidas en el Worker.
import { err } from '../../core/domain/errors.js';
import { allowEgressHost } from './egress-guard.js';

const CERT_CACHE_MS = 60 * 60 * 1000;
let certCache = { at: 0, keys: new Map() };

export function accessJwtEnabled(env = {}) {
  const team = String(env.ACCESS_TEAM_DOMAIN ?? '').trim();
  const aud = String(env.ACCESS_AUD ?? '').trim();
  return !!(team && aud);
}

export function teamDomainHostname(env) {
  const raw = String(env.ACCESS_TEAM_DOMAIN ?? '').trim();
  if (!raw) return null;
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function decodeBase64Url(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header; let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch {
    return null;
  }
  return { header, payload, signature: decodeBase64Url(parts[2]), signingInput: `${parts[0]}.${parts[1]}` };
}

async function importVerifyKeyFromCertPem(pem) {
  let X509 = globalThis.crypto?.X509Certificate;
  if (!X509) {
    try { X509 = (await import('node:crypto')).X509Certificate; } catch { /* Workers */ }
  }
  if (!X509) throw new Error('X509Certificate no disponible');
  const cert = new X509(pem);
  const pk = cert.publicKey;
  if (pk instanceof CryptoKey) return pk;
  const spki = pk.export({ format: 'der', type: 'spki' });
  return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

async function verifySignatureRs256(signingInput, signature, keys) {
  const data = new TextEncoder().encode(signingInput);
  for (const key of keys) {
    if (await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data)) return true;
  }
  return false;
}

export async function loadKeysFromCertsJson(data) {
  const list = data?.public_certs ?? (data?.public_cert ? [data.public_cert] : []);
  const keys = new Map();
  for (const entry of list) {
    if (!entry?.kid || !entry?.cert) continue;
    keys.set(entry.kid, await importVerifyKeyFromCertPem(entry.cert));
  }
  return keys;
}

export async function fetchTeamCertKeys(env, fetchImpl = globalThis.fetch) {
  const host = teamDomainHostname(env);
  if (!host) throw err('SERVER_MISCONFIGURED', 'ACCESS_TEAM_DOMAIN inválido', 500);
  const now = Date.now();
  if (certCache.at && now - certCache.at < CERT_CACHE_MS && certCache.keys.size) return certCache.keys;
  allowEgressHost(host);
  const res = await fetchImpl(`https://${host}/cdn-cgi/access/certs`);
  if (!res.ok) throw err('ACCESS_CERT_FETCH_FAILED', 'No se pudieron obtener certificados Access', 502);
  const data = await res.json();
  const keys = await loadKeysFromCertsJson(data);
  certCache = { at: now, keys };
  return keys;
}

/** @param {{ getCertKeys?: (env) => Promise<Map<string,CryptoKey>>, now?: number }} [deps] */
export async function verifyAccessJwt(request, env, deps = {}) {
  if (!accessJwtEnabled(env)) return null;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw err('ACCESS_DENIED', 'Falta cabecera Cf-Access-Jwt-Assertion', 403);

  const parsed = parseJwt(token);
  if (!parsed) throw err('ACCESS_DENIED', 'JWT Access mal formado', 403);

  const nowSec = Math.floor((deps.now ?? Date.now()) / 1000);
  if (parsed.payload.exp !== undefined && nowSec >= Number(parsed.payload.exp)) {
    throw err('ACCESS_DENIED', 'JWT Access expirado', 403);
  }
  const aud = parsed.payload.aud;
  const expected = String(env.ACCESS_AUD).trim();
  const audOk = Array.isArray(aud) ? aud.includes(expected) : aud === expected;
  if (!audOk) throw err('ACCESS_DENIED', 'Audience JWT Access inválido', 403);

  const kid = parsed.header.kid;
  const keyMap = deps.getCertKeys ? await deps.getCertKeys(env) : await fetchTeamCertKeys(env, deps.fetchImpl);
  const keys = kid && keyMap.has(kid) ? [keyMap.get(kid)] : [...keyMap.values()];
  if (!keys.length) throw err('ACCESS_DENIED', 'No hay claves para verificar JWT Access', 403);

  if (!(await verifySignatureRs256(parsed.signingInput, parsed.signature, keys))) {
    throw err('ACCESS_DENIED', 'Firma JWT Access inválida', 403);
  }
  return parsed.payload;
}

export function resetAccessJwtCertCache() {
  certCache = { at: 0, keys: new Map() };
}