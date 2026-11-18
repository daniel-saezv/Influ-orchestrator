// Subida por partes de la persona. El cuerpo no se hashea aquí.
import { err } from '../core/domain/errors.js';
import { assertNoControlFields, assertSha256 } from '../core/domain/encargos.js';
import {
  MAX_CLASS_A_GLOBAL, MAX_CLASS_A_USER, MAX_CLASS_B_GLOBAL, MAX_CLASS_B_USER,
  MAX_FILE_BYTES, MAX_GLOBAL_BYTES, MAX_USER_BYTES, PART_SIZE_BYTES,
  expectedPartSize, partCountFor, windowStart,
} from '../core/domain/r2-quota.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIME_RE = /^(video|image|audio)\/[\w.+-]+$/;
const NOT_FOUND = () => err('NOT_FOUND', 'No encontrado', 404);

function parseParts(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

function storedSize(parts) {
  return Object.values(parts).reduce((sum, part) => sum + Number(part.size), 0);
}

async function requireUser(repo, email) {
  const user = await repo.userByEmail(email);
  if (!user) throw NOT_FOUND();
  return user;
}

export async function createUpload(repo, { email, body, now, r2 }) {
  assertNoControlFields(body);
  if (!r2) throw err('R2_UNAVAILABLE', 'El almacenamiento no está disponible', 503);
  const user = await requireUser(repo, email);
  if (body.resume_id !== undefined && body.resume_id !== null) {
    if (!UUID_RE.test(body.resume_id)) throw NOT_FOUND();
    const session = await repo.uploadForUser(user.user_id, body.resume_id);
    if (!session || session.completed_at) throw NOT_FOUND();
    if (Number(body.size_bytes) !== Number(session.size_bytes)
      || body.mime !== session.mime
      || (body.sha256 && session.file_sha256 && body.sha256 !== session.file_sha256)) {
      throw err('CONFLICT', 'La subida a medias no corresponde a este archivo', 409);
    }
    const parts = parseParts(session.part_hashes_json);
    return {
      __http: 201,
      upload_id: session.upload_id,
      encargo_id: session.encargo_id,
      part_size: PART_SIZE_BYTES,
      part_count: session.expected_parts,
      uploaded_parts: Object.keys(parts).map(Number).sort((a, b) => a - b),
      resumed: true,
    };
  }
  if (!UUID_RE.test(body.encargo_id ?? '')) throw NOT_FOUND();
  const encargo = await repo.encargoForEmail(email, body.encargo_id);
  if (!encargo) throw NOT_FOUND();
  if (encargo.status !== 'draft' && encargo.status !== 'queued') {
    throw err('CONFLICT', 'Este encargo no admite una subida', 409);
  }
  if (await repo.openUploadForEncargo(encargo.encargo_id)) {
    throw err('CONFLICT', 'Ya hay una subida abierta para este encargo', 409);
  }
  const size = body.size_bytes;
  if (!Number.isInteger(size) || size <= 0) throw err('INVALID_INPUT', 'El tamaño debe ser positivo', 400);
  if (size > MAX_FILE_BYTES) throw err('QUOTA_EXCEEDED', 'El archivo supera el máximo de 150 MiB', 413);
  const mime = body.mime;
  if (typeof mime !== 'string' || !MIME_RE.test(mime)) throw err('INVALID_INPUT', 'mime no válido', 400);
  let fileSha = null;
  if (body.sha256 !== undefined && body.sha256 !== null) fileSha = assertSha256(body.sha256, 'sha256');
  const count = partCountFor(size);
  const since = windowStart(now);
  const userOps = await repo.classUsed(user.user_id, 'a', since);
  const globalOps = await repo.classUsed('global', 'a', since);
  if (userOps + count > MAX_CLASS_A_USER || globalOps + count > MAX_CLASS_A_GLOBAL) {
    throw err('QUOTA_EXCEEDED', 'No cabe en el tope de escrituras', 413);
  }
  const held = await repo.reserveBytes(user.user_id, size, MAX_USER_BYTES, MAX_GLOBAL_BYTES);
  if (!held) throw err('QUOTA_EXCEEDED', 'No cabe en el tope de almacenamiento', 413);
  const uploadId = crypto.randomUUID();
  try {
    await repo.insertUploadSession({
      uploadId, userId: user.user_id, encargoId: encargo.encargo_id, sizeBytes: size, mime,
      expectedParts: count, fileSha, bytesReserved: size, now,
    });
  } catch (error) {
    await repo.releaseBytes(user.user_id, size);
    throw error;
  }
  await repo.noteBytesPeak(user.user_id, now);
  return {
    __http: 201,
    upload_id: uploadId,
    encargo_id: body.encargo_id,
    part_size: PART_SIZE_BYTES,
    part_count: count,
    uploaded_parts: [],
    resumed: false,
  };
}

export async function putUploadPart(ctx, { email, uploadId, part, request, now }) {
  const { repo, r2 } = ctx;
  if (!UUID_RE.test(uploadId ?? '')) throw NOT_FOUND();
  const user = await requireUser(repo, email);
  const session = await repo.uploadForUser(user.user_id, uploadId);
  if (!session || session.completed_at) throw NOT_FOUND();
  const n = Number(part);
  if (!Number.isInteger(n) || n < 1 || n > session.expected_parts) {
    throw err('INVALID_INPUT', 'Número de parte inválido', 400);
  }
  const expected = expectedPartSize(session.size_bytes, n);
  const length = Number(request.headers.get('content-length'));
  if (length !== expected) throw err('INVALID_INPUT', 'El tamaño de la parte no coincide', 400);
  const sha = (request.headers.get('x-content-sha256') ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw err('INVALID_INPUT', 'X-Content-Sha256 debe ser un SHA-256 en hex', 400);
  const parts = parseParts(session.part_hashes_json);
  if (parts[n]) {
    if (parts[n].sha256 !== sha) throw err('CONFLICT', 'La parte ya se guardó con otra huella', 409);
    return { part: n, uploaded: true, already_uploaded: true, sha256: parts[n].sha256 };
  }
  if (!r2) throw err('R2_UNAVAILABLE', 'El almacenamiento no está disponible', 503);
  const unstored = Number(session.bytes_reserved) - storedSize(parts);
  let extra = 0;
  if (unstored < expected) {
    extra = expected - Math.max(unstored, 0);
    const held = await repo.reserveBytes(user.user_id, extra, MAX_USER_BYTES, MAX_GLOBAL_BYTES);
    if (!held) throw err('QUOTA_EXCEEDED', 'No cabe en el tope de almacenamiento', 413);
    await repo.addReserved(session.upload_id, extra, now);
  }
  const reservedOp = await repo.reserveDaily(user.user_id, 'a', now, MAX_CLASS_A_USER, MAX_CLASS_A_GLOBAL);
  if (!reservedOp) {
    if (extra) {
      await repo.releaseBytes(user.user_id, extra);
      await repo.addReserved(session.upload_id, -extra, now);
    }
    throw err('QUOTA_EXCEEDED', 'Tope de escrituras alcanzado', 413);
  }
  const key = `pending/${user.user_id}/${session.upload_id}/${String(n).padStart(2, '0')}`;
  const contentType = request.headers.get('content-type') || session.mime || 'application/octet-stream';
  try {
    const stored = await r2.put(key, request.body, { sha256: sha, contentType });
    if (stored.size !== expected || stored.sha256 !== sha) {
      await r2.delete(key).catch(() => {});
      await repo.releasePartHold(session.upload_id, user.user_id, expected, now);
      throw err('CHECKSUM_MISMATCH', 'El contenido no coincide con el SHA-256', 400);
    }
    const saved = await repo.recordPart(session.upload_id, n, { sha256: stored.sha256, size: stored.size, key }, now);
    if (saved === 'conflict') {
      await r2.delete(key).catch(() => {});
      throw err('CONFLICT', 'La parte ya se guardó con otra huella', 409);
    }
    if (saved !== 'saved' && saved !== 'same') {
      await r2.delete(key).catch(() => {});
      throw err('CONFLICT', 'No se pudo registrar la parte', 409);
    }
    return { part: n, uploaded: true, already_uploaded: saved === 'same', sha256: stored.sha256 };
  } catch (error) {
    if (error?.code && error.http) throw error;
    if (error?.code === 'CHECKSUM_MISMATCH') {
      await repo.releasePartHold(session.upload_id, user.user_id, expected, now);
      throw err('CHECKSUM_MISMATCH', 'El contenido no coincide con el SHA-256', 400);
    }
    await repo.releaseDaily(user.user_id, 'a', now);
    throw err('R2_UNAVAILABLE', 'No se pudo guardar la parte', 503);
  }
}

export async function completeUpload(repo, { email, uploadId, body, now }) {
  assertNoControlFields(body);
  if (!UUID_RE.test(uploadId ?? '')) throw NOT_FOUND();
  const user = await requireUser(repo, email);
  const session = await repo.uploadForUser(user.user_id, uploadId);
  if (!session) throw NOT_FOUND();
  if (session.completed_at) throw err('CONFLICT', 'La subida ya está cerrada', 409);
  const fileSha = assertSha256(body?.sha256, 'sha256');
  if (session.file_sha256 && session.file_sha256 !== fileSha) {
    throw err('CONFLICT', 'La huella del archivo no coincide', 409);
  }
  const parts = parseParts(session.part_hashes_json);
  if (Object.keys(parts).length !== session.expected_parts) {
    throw err('UPLOAD_INCOMPLETE', 'Faltan partes por subir', 409);
  }
  for (let n = 1; n <= session.expected_parts; n += 1) {
    if (!parts[n]?.sha256 || !parts[n]?.key) throw err('UPLOAD_INCOMPLETE', 'Faltan partes por subir', 409);
  }
  const partSum = storedSize(parts);
  if (partSum !== session.size_bytes || Number(session.bytes_reserved) !== session.size_bytes) {
    throw err('CONFLICT', 'El tamaño reservado no coincide con las partes', 409);
  }
  const closed = await repo.markUploadComplete({ uploadId, fileSha, now });
  if (!closed) throw err('CONFLICT', 'La subida ya está cerrada', 409);
  const linked = [];
  for (let n = 1; n <= session.expected_parts; n += 1) {
    linked.push({ key: parts[n].key, sha256: parts[n].sha256, size: parts[n].size });
  }
  await repo.linkSourceParts({ encargoId: session.encargo_id, mime: session.mime, parts: linked, now });
  const encargo = await repo.encargoForEmail(email, session.encargo_id);
  return {
    upload_id: uploadId,
    encargo_id: session.encargo_id,
    sha256: fileSha,
    size_bytes: session.size_bytes,
    complete: true,
    status: encargo?.status ?? 'queued',
  };
}

export async function getMediaResponse(ctx, { email, sha256, now }) {
  const hash = /^[a-f0-9]{64}$/.test(sha256 ?? '') ? sha256 : null;
  if (!hash) throw NOT_FOUND();
  const user = await ctx.repo.userByEmail(email);
  if (!user) throw NOT_FOUND();
  const asset = await ctx.repo.mediaForEmail(email, hash);
  if (!asset || asset.delete_pending) throw NOT_FOUND();
  if (!ctx.r2) throw err('R2_UNAVAILABLE', 'El almacenamiento no está disponible', 503);
  const reserved = await ctx.repo.reserveDaily(user.user_id, 'b', now, MAX_CLASS_B_USER, MAX_CLASS_B_GLOBAL);
  if (!reserved) throw err('QUOTA_EXCEEDED', 'Tope de lecturas alcanzado', 413);
  let object;
  try {
    object = await ctx.r2.get(asset.r2_key);
  } catch {
    await ctx.repo.releaseDaily(user.user_id, 'b', now);
    throw err('R2_UNAVAILABLE', 'No se pudo leer el archivo', 503);
  }
  if (!object || object.sha256 !== hash) throw err('INTEGRITY_ERROR', 'El objeto almacenado no coincide', 500);
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': asset.mime || object.mime || 'application/octet-stream',
      'content-length': String(object.size),
      'x-content-sha256': object.sha256,
      'cache-control': 'private, no-store',
      'x-influ-mode': 'mock',
    },
  });
}
