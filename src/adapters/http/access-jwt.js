// Validación de Cf-Access-Jwt-Assertion (segunda capa tras Cloudflare Access en el edge).
// Con ACCESS_TEAM_DOMAIN y ACCESS_AUD, todas las rutas salvo /mcp comprueban firma, aud y, si vienen, exp, nbf e iss.
// En el runtime de Cloudflare, o con ACCESS_JWT_REQUIRED=true, faltar esas dos vars es 503: no se atiende la ruta.
// En Node (pruebas y aceptación local), sin esa exigencia, la ausencia de vars deja la comprobación en pausa.
// /mcp no usa este atajo: exige ACCESS_MCP_AUD y el common_name del service token del conector.
import { err } from '../../core/domain/errors.js';
import { allowEgressHost } from './egress-guard.js';

const CERT_CACHE_MS = 60 * 60 * 1000;
let certCache = { at: 0, keys: new Map() };

export function accessJwtEnabled(env = {}) {
  const team = String(env.ACCESS_TEAM_DOMAIN ?? '').trim();
  const aud = String(env.ACCESS_AUD ?? '').trim();
  return !!(team && aud);
}

export function runningOnCloudflareWorkers() {
  return globalThis.navigator?.userAgent === 'Cloudflare-Workers';
}

/** Producción (y cualquier Worker desplegado) no puede quedar sin Access. Node, sin la var, sí. */
export function accessJwtMustBeConfigured(env = {}, deps = {}) {
  if (String(env.ACCESS_JWT_REQUIRED ?? '').trim().toLowerCase() === 'true') return true;
  if (typeof deps.onCloudflare === 'boolean') return deps.onCloudflare;
  return runningOnCloudflareWorkers();
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

/** iss que firma Access: https://<team>.cloudflareaccess.com */
export function accessTeamIssuer(env) {
  const host = teamDomainHostname(env);
  return host ? `https://${host}` : null;
}

export function mcpAccessConfigured(env = {}) {
  return !!(
    accessTeamIssuer(env)
    && String(env.ACCESS_MCP_AUD ?? '').trim()
    && String(env.MCP_SERVICE_TOKEN_CLIENT_ID ?? '').trim()
  );
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

function audienceMatches(aud, expected) {
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

function assertLifetimeAndIssuer(payload, env, nowSec, strict) {
  const expPresent = payload.exp !== undefined && payload.exp !== null && payload.exp !== '';
  const nbfPresent = payload.nbf !== undefined && payload.nbf !== null && payload.nbf !== '';
  const issPresent = payload.iss !== undefined && payload.iss !== null && payload.iss !== '';
  if (strict && (!expPresent || !nbfPresent || !issPresent)) {
    throw err('ACCESS_DENIED', 'JWT Access incompleto', 403);
  }
  if (expPresent) {
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp) || nowSec >= exp) throw err('ACCESS_DENIED', 'JWT Access expirado', 403);
  }
  if (nbfPresent) {
    const nbf = Number(payload.nbf);
    if (!Number.isFinite(nbf) || nowSec < nbf) throw err('ACCESS_DENIED', 'JWT Access aún no válido', 403);
  }
  if (strict || issPresent) {
    const expectedIss = accessTeamIssuer(env);
    if (!expectedIss || payload.iss !== expectedIss) throw err('ACCESS_DENIED', 'Issuer JWT Access inválido', 403);
  }
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

/**
 * @param {{ getCertKeys?: (env) => Promise<Map<string,CryptoKey>>, now?: number, onCloudflare?: boolean, fetchImpl?: typeof fetch }} [deps]
 * @param {{ audience: string, strictClaims?: boolean }} options
 */
async function verifyAccessAssertion(request, env, deps, { audience, strictClaims }) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw err('ACCESS_DENIED', 'Falta cabecera Cf-Access-Jwt-Assertion', 403);

  const parsed = parseJwt(token);
  if (!parsed) throw err('ACCESS_DENIED', 'JWT Access mal formado', 403);
  if (parsed.header?.alg !== 'RS256') throw err('ACCESS_DENIED', 'JWT Access debe ir firmado con RS256', 403);

  const nowSec = Math.floor((deps.now ?? Date.now()) / 1000);
  assertLifetimeAndIssuer(parsed.payload, env, nowSec, !!strictClaims);

  if (!audienceMatches(parsed.payload.aud, audience)) {
    throw err('ACCESS_DENIED', 'Audience JWT Access inválido', 403);
  }

  const kid = parsed.header.kid;
  const keyMap = deps.getCertKeys ? await deps.getCertKeys(env) : await fetchTeamCertKeys(env, deps.fetchImpl);
  const keys = kid && keyMap.has(kid) ? [keyMap.get(kid)] : [...keyMap.values()];
  if (!keys.length) throw err('ACCESS_DENIED', 'No hay claves para verificar JWT Access', 403);

  if (!(await verifySignatureRs256(parsed.signingInput, parsed.signature, keys))) {
    throw err('ACCESS_DENIED', 'Firma JWT Access inválida', 403);
  }
  return parsed.payload;
}

/** @param {{ getCertKeys?: (env) => Promise<Map<string,CryptoKey>>, now?: number, onCloudflare?: boolean }} [deps] */
export async function verifyAccessJwt(request, env, deps = {}) {
  if (!accessJwtEnabled(env)) {
    if (accessJwtMustBeConfigured(env, deps)) {
      throw err('SERVER_MISCONFIGURED', 'Faltan ACCESS_TEAM_DOMAIN o ACCESS_AUD', 503);
    }
    return null;
  }
  return verifyAccessAssertion(request, env, deps, {
    audience: String(env.ACCESS_AUD).trim(),
    strictClaims: false,
  });
}

function commonNameMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * JWT de la aplicación Access que cubre solo /mcp.
 * No exige email. common_name tiene que ser el Client ID del service token del conector.
 * Un JWT de persona (aud de la UI) no pasa.
 * Si falta la config, 503 y el llamador no debe ejecutar el conector.
 */
export async function verifyMcpServiceToken(request, env, deps = {}) {
  if (!mcpAccessConfigured(env)) {
    throw err('SERVER_MISCONFIGURED', 'Falta la configuración de Access para /mcp', 503);
  }
  let payload;
  try {
    payload = await verifyAccessAssertion(request, env, deps, {
      audience: String(env.ACCESS_MCP_AUD).trim(),
      strictClaims: true,
    });
  } catch (error) {
    if (error?.code === 'ACCESS_DENIED') throw err('UNAUTHENTICATED', 'MCP no autorizado', 401);
    throw error;
  }
  const expected = String(env.MCP_SERVICE_TOKEN_CLIENT_ID).trim();
  if (!commonNameMatches(payload.common_name, expected)) {
    throw err('UNAUTHENTICATED', 'MCP no autorizado', 401);
  }
  return payload;
}

/**
 * La capa de aplicación no reenvía el secreto del service token ni el bearer.
 * Tampoco vuelve a fijar cabeceras `cf-*`: en el runtime de Workers no están permitidas
 * al construir una Request, y el JWT ya se validó antes de llegar al conector.
 */
export function omitAccessClientSecret(request) {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const name = key.toLowerCase();
    if (name === 'cf-access-client-secret' || name === 'authorization' || name.startsWith('cf-')) continue;
    headers.append(key, value);
  }
  return new Request(request, { headers });
}

export function resetAccessJwtCertCache() {
  certCache = { at: 0, keys: new Map() };
}
