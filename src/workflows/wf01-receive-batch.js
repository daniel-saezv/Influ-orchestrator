// WF-01 RECEIVE_BATCH — recibe un lote (o una versión nueva), valida estructura, publicaciones y
// archivos, calcula la huella, registra lote y publicaciones y devuelve el resultado.
import { validateBatchInput } from '../core/domain/batch.js';
import { contentHash } from '../core/domain/hash.js';
import { err } from '../core/domain/errors.js';
import { BatchStatus as BS, PublicationStatus as PS, BATCH_EDITABLE } from '../core/domain/states.js';
import { toNormalizedPost } from './common.js';

export async function receiveBatch(input, ctx, { mode = 'create', note } = {}) {
  const now = ctx.now();
  const batch = validateBatchInput(input);
  // 1) Archivos: deben existir en el almacenamiento y coincidir con lo declarado.
  const fileErrors = [];
  const uniqueShas = [...new Set(batch.publications.map((p) => p.media.sha256))];
  const heads = await Promise.all(uniqueShas.map((sha) => ctx.media.head(sha)));
  const seen = new Map(uniqueShas.map((sha, index) => [sha, heads[index]]));
  for (const p of batch.publications) {
    const h = seen.get(p.media.sha256);
    if (!h) fileErrors.push({ field: `P${p.seq}.media`, message: `Archivo no encontrado en el almacenamiento: ${p.media.filename} (${p.media.sha256.slice(0, 12)}…)` });
    else {
      if (h.size_bytes !== p.media.size_bytes) fileErrors.push({ field: `P${p.seq}.media.size_bytes`, message: `Tamaño declarado ${p.media.size_bytes} != almacenado ${h.size_bytes}` });
      if (h.mime !== p.media.mime) fileErrors.push({ field: `P${p.seq}.media.mime`, message: `MIME declarado ${p.media.mime} != almacenado ${h.mime}` });
    }
  }
  if (fileErrors.length) throw err('MEDIA_INVALID', 'Archivos multimedia ausentes o incoherentes', 400, fileErrors);

  // 2) Huella e idempotencia / control de versiones.
  const hash = await contentHash(batch);
  const existing = await ctx.repo.getBatch(batch.batch_id);
  let version = 1;
  if (mode === 'create') {
    if (existing) {
      if (existing.content_hash === hash) return { idempotent: true, ...summary(existing) };
      throw err('BATCH_EXISTS', `El lote ${batch.batch_id} ya existe con otro contenido; envía una nueva versión (updateBatch)`, 409);
    }
  } else {
    if (!existing) throw err('BATCH_NOT_FOUND', `No existe ${batch.batch_id}`, 404);
    if (!BATCH_EDITABLE.has(existing.status)) throw err('BATCH_LOCKED', `El lote está en ${existing.status}; ya no admite cambios`, 409);
    if (existing.content_hash === hash) return { idempotent: true, ...summary(existing) };
    version = existing.version + 1;
  }

  // 3) Validación específica de cada plataforma mediante su adaptador (sin red).
  const validation = await Promise.all(batch.publications.map(async (p) => {
    const post = toNormalizedPost(batch, version, hash, p);
    const adapter = ctx.registry.forPlatform(p.platform);
    const r = await adapter.validatePost(post);
    return { seq: p.seq, publication_id: post.publication_id, platform: p.platform, ok: r.ok, errors: r.errors ?? [], warnings: r.warnings ?? [], adapter: adapter.info.implementation };
  }));
  const allOk = validation.every((v) => v.ok);
  const status = allOk ? BS.READY_FOR_REVIEW : BS.DRAFT;
  const okBySeq = new Map(validation.map((v) => [v.seq, v.ok]));
  const wasApproved = existing && (existing.status === BS.APPROVED || existing.approved_hash);

  await ctx.repo.insertBatchVersion({
    batch, version, hash, status, actor: ctx.actor, note, validation, now, isNew: mode === 'create',
    pubStatus: (p) => (okBySeq.get(p.seq) ? PS.VALIDATED : PS.DRAFT),
    invalidateReason: `Contenido modificado: versión ${version} (huella ${hash.slice(0, 12)}…)`,
  });
  await ctx.repo.audit(ctx.actor, mode === 'create' ? 'BATCH_RECEIVED' : 'BATCH_NEW_VERSION', batch.batch_id, { version, hash, status, approval_invalidated: !!wasApproved }, now);
  const saved = await ctx.repo.getBatch(batch.batch_id);
  return { idempotent: false, approval_invalidated: !!wasApproved, ...summary(saved) };
}

export function summary(b) {
  return {
    batch_id: b.batch_id, version: b.version, status: b.status, content_hash: b.content_hash,
    created_at: b.created_at, updated_at: b.updated_at, approved_at: b.approved_at, approved_by: b.approved_by,
    approved_version: b.approved_version, validation: b.validation,
  };
}
