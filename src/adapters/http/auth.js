// Autenticación de Webhooks: HMAC-SHA256 con marca de tiempo + nonce (anti-replay).
// Cadena firmada:  v1\n<timestamp>\n<nonce>\n<METHOD>\n<path+query>\n<sha256(body)>
// Cabeceras: X-Influ-Key-Id (bot | approver), X-Influ-Timestamp (s), X-Influ-Nonce, X-Influ-Signature (v1=<hex>)
// Las claves son Secrets de Workers; nunca viajan en la petición ni se registran.
import { sha256Hex } from '../../core/domain/hash.js';
import { err } from '../../core/domain/errors.js';

export const KEY_SECRETS = { bot: 'BOT_HMAC_SECRET', approver: 'APPROVER_HMAC_SECRET' };

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signingString({ timestamp, nonce, method, pathAndQuery, body }) {
  const bodyHash = await sha256Hex(body ?? new Uint8Array());
  return ['v1', timestamp, nonce, method.toUpperCase(), pathAndQuery, bodyHash].join('\n');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Verifica la firma. Devuelve el keyId autenticado o lanza 401. */
export async function verifyRequest(request, bodyBytes, env, { windowSeconds, useNonce, allowedKeys }) {
  const h = (n) => request.headers.get(n);
  const keyId = h('x-influ-key-id');
  const ts = h('x-influ-timestamp');
  const nonce = h('x-influ-nonce');
  const sig = h('x-influ-signature');
  if (!keyId || !ts || !nonce || !sig) throw err('UNAUTHENTICATED', 'Faltan cabeceras de autenticación', 401);
  if (!allowedKeys.includes(keyId)) throw err('FORBIDDEN', `La clave ${keyId} no está autorizada para esta operación`, 403);
  const secret = env[KEY_SECRETS[keyId]];
  if (!secret || secret.length < 32) throw err('SERVER_MISCONFIGURED', 'Secreto no configurado', 500);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw err('UNAUTHENTICATED', 'Nonce inválido', 401);
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > windowSeconds) throw err('UNAUTHENTICATED', 'Marca de tiempo fuera de la ventana permitida', 401);
  const url = new URL(request.url);
  const expected = 'v1=' + await hmacHex(secret, await signingString({ timestamp: ts, nonce, method: request.method, pathAndQuery: url.pathname + url.search, body: bodyBytes }));
  if (!timingSafeEqualHex(sig, expected)) throw err('UNAUTHENTICATED', 'Firma inválida', 401);
  if (!(await useNonce(nonce, keyId))) throw err('REPLAY_DETECTED', 'Nonce ya utilizado (posible repetición)', 401);
  return keyId;
}
