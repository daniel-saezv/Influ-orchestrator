import { err } from '../core/domain/errors.js';
import { assertSha256 } from '../core/domain/encargos.js';
import { assertDeliverableMime } from '../core/domain/formats.js';
import {
  MAX_CLASS_A_GLOBAL, MAX_CLASS_A_USER, MAX_FILE_BYTES, MAX_GLOBAL_BYTES, MAX_USER_BYTES,
} from '../core/domain/r2-quota.js';
import { PRESIGN_TTL_SECONDS, signingUnavailableError } from '../adapters/storage/r2-presign.js';
import { releaseExpiredReservations, releaseReservationHold } from './r2-gc.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_FOUND = () => err('NOT_FOUND', 'No encontrado', 404);

function demandSigner(signer, env) {
  if (signer) return signer;
  throw signingUnavailableError(env);
}

function expiresAt(now, seconds) {
  return new Date(Date.parse(now) + seconds * 1000).toISOString();
}

function assertContentMd5(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    throw err('INVALID_INPUT', 'content_md5 debe ser el MD5 en base64', 400);
  }
  let raw;
  try {
    raw = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw err('INVALID_INPUT', 'content_md5 debe ser el MD5 en base64', 400);
  }
  if (raw.byteLength !== 16) throw err('INVALID_INPUT', 'content_md5 debe ser el MD5 en base64', 400);
  return value;
}

function assertUploadMime(value, format) {
  return assertDeliverableMime(format, value);
}

function assertUploadSize(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_FILE_BYTES) {
    throw err('INVALID_INPUT', 'El tamaño debe estar entre 1 byte y 150 MiB', 400);
  }
  return value;
}

function putHeaders(mime, sizeBytes, contentMd5) {
  return {
    'Content-Type': mime,
    'Content-Length': String(sizeBytes),
    'Content-MD5': contentMd5,
    'If-None-Match': '*',
  };
}

function sameReservation(row, { sha256, contentMd5, mime, sizeBytes, version }) {
  return row.sha256 === sha256
    && row.content_md5 === contentMd5
    && row.mime === mime
    && Number(row.size_bytes) === sizeBytes
    && Number(row.version) === version;
}

async function signedPut(signer, row, now) {
  const ttl = Math.floor((Date.parse(row.expires_at) - Date.parse(now)) / 1000);
  if (ttl < 1) return null;
  const headers = putHeaders(row.mime, Number(row.size_bytes), row.content_md5);
  const url = await signer.signPut(row.r2_key, headers, ttl);
  return { r2_key: row.r2_key, url, headers, expires_at: row.expires_at };
}

export async function prepareDeliverableUpload(repo, {
  encargoId, sha256, contentMd5, mime, sizeBytes, now, signer = null, env = null, actor = 'mcp',
}) {
  if (!UUID_RE.test(encargoId ?? '')) throw NOT_FOUND();
  const encargo = await repo.encargoById(encargoId);
  if (!encargo) throw NOT_FOUND();
  if (encargo.status !== 'claimed') throw err('CONFLICT', 'El encargo no está reclamado', 409);
  const hash = assertSha256(sha256, 'sha256');
  const md5 = assertContentMd5(contentMd5);
  const type = assertUploadMime(mime, encargo.format ?? null);
  const size = assertUploadSize(sizeBytes);
  const activeSigner = demandSigner(signer, env);
  const version = encargo.delivered ? Number(encargo.version) + 1 : Number(encargo.version);
  await releaseExpiredReservations({ repo, now: () => now });
  const open = await repo.listOpenReservations(encargoId);
  const live = [];
  for (const row of open) {
    if (row.expires_at <= now) {
      await releaseReservationHold(repo, row, now);
      continue;
    }
    live.push(row);
  }
  const reusable = live.find((row) => sameReservation(row, { sha256: hash, contentMd5: md5, mime: type, sizeBytes: size, version }));
  if (reusable) {
    const again = await signedPut(activeSigner, reusable, now);
    if (again) return again;
    await releaseReservationHold(repo, reusable, now);
  } else if (live.length) {
    throw err('CONFLICT', 'Ya hay una subida preparada para este encargo', 409);
  }
  const held = await repo.reserveBytes(encargo.user_id, size, MAX_USER_BYTES, MAX_GLOBAL_BYTES);
  if (!held) throw err('QUOTA_EXCEEDED', 'No cabe en el tope de almacenamiento', 413);
  const reservedOp = await repo.reserveDaily(encargo.user_id, 'a', now, MAX_CLASS_A_USER, MAX_CLASS_A_GLOBAL);
  if (!reservedOp) {
    await repo.releaseBytes(encargo.user_id, size);
    throw err('QUOTA_EXCEEDED', 'Tope de escrituras alcanzado', 413);
  }
  const r2Key = `out/${encargo.encargo_id}/${version}/${crypto.randomUUID()}`;
  const expiry = expiresAt(now, PRESIGN_TTL_SECONDS);
  const reservationId = crypto.randomUUID();
  try {
    await repo.insertDeliverableReservation({
      reservationId, encargoId: encargo.encargo_id, userId: encargo.user_id, r2Key, version,
      sha256: hash, contentMd5: md5, mime: type, sizeBytes: size, bytesHeld: size, classAHeld: 1,
      quotaDay: now.slice(0, 10), expiresAt: expiry, now,
    });
  } catch (error) {
    await repo.releaseDaily(encargo.user_id, 'a', now);
    await repo.releaseBytes(encargo.user_id, size);
    throw error;
  }
  await repo.noteBytesPeak(encargo.user_id, now);
  const headers = putHeaders(type, size, md5);
  let url;
  try {
    url = await activeSigner.signPut(r2Key, headers, PRESIGN_TTL_SECONDS);
  } catch (error) {
    await releaseReservationHold(repo, {
      reservation_id: reservationId, user_id: encargo.user_id, bytes_held: size, class_a_held: 1, quota_day: now.slice(0, 10),
    }, now);
    throw error;
  }
  await repo.audit(actor, 'ENCARGO_UPLOAD_PREPARED', null, {
    encargo_id: encargo.encargo_id, account_id: encargo.account_id, r2_key: r2Key, size_bytes: size, expires_at: expiry,
  }, now);
  return { r2_key: r2Key, url, headers, expires_at: expiry };
}
