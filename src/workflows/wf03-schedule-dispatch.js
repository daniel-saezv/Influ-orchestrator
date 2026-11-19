// WF-03 SCHEDULE_AND_DISPATCH — se ejecuta periódicamente (Cron Trigger) o a demanda.
// Busca lotes aprobados, comprueba que la aprobación sigue siendo válida, que ha llegado la hora,
// evita duplicados (reclamo atómico) y envía cada publicación al adaptador (WF-04).
import { err } from '../core/domain/errors.js';
import { contentHash } from '../core/domain/hash.js';
import { BatchStatus as BS, PublicationStatus as PS, aggregateBatchStatus } from '../core/domain/states.js';
import { publishOne } from './wf04-publisher.js';
import { releaseEncargoObjects } from './r2-gc.js';

export async function verifyApproval(b, ctx) {
  const reasons = [];
  if (![BS.APPROVED, BS.PUBLISHING].includes(b.status)) reasons.push(`estado del lote ${b.status}`);
  const [a, storedHash] = await Promise.all([
    ctx.repo.getValidApproval(b.batch_id),
    contentHash(b.payload),
  ]);
  if (!a) reasons.push('no hay aprobación válida');
  else {
    if (a.version !== b.version) reasons.push(`aprobación de la versión ${a.version}, lote en versión ${b.version}`);
    if (a.content_hash !== b.content_hash) reasons.push('la huella aprobada no coincide con la actual');
  }
  if (b.approved_hash !== b.content_hash || b.approved_version !== b.version) reasons.push('registro de aprobación del lote incoherente');
  if (storedHash !== b.content_hash) reasons.push('el contenido almacenado no coincide con su huella');
  return { valid: reasons.length === 0, reasons, approval: a };
}

/** Intento explícito de publicar un lote: se bloquea si no hay aprobación válida. */
export async function publishBatchNow(batchId, ctx) {
  const b = await ctx.repo.getBatch(batchId);
  if (!b) throw err('BATCH_NOT_FOUND', `No existe ${batchId}`, 404);
  const v = await verifyApproval(b, ctx);
  if (!v.valid) {
    await ctx.repo.audit(ctx.actor, 'PUBLISH_BLOCKED', batchId, { reasons: v.reasons }, ctx.now());
    throw err('APPROVAL_REQUIRED', 'Publicación bloqueada: el lote no tiene una aprobación válida', 409, v.reasons);
  }
  return dispatch({ batchId, trigger: 'manual-publish' }, ctx);
}

export async function dispatch({ batchId, trigger = 'manual' } = {}, ctx) {
  const cfg = ctx.registry.config; // si se pidió LIVE sin garantías, la creación del registro ya falló
  const now = ctx.now();
  const out = { trigger, mode: cfg.mode, provider_default: cfg.provider, at: now, batches: [] };
  let budget = ctx.settings.maxPublicationsPerRun;
  const ids = await ctx.repo.listDispatchableBatches(batchId);
  for (const id of ids) {
    const run = { batch_id: id, processed: [], skipped: [] };
    out.batches.push(run);
    const b = await ctx.repo.getBatch(id);
    const v = await verifyApproval(b, ctx);
    if (!v.valid) {
      run.blocked = v.reasons;
      await ctx.repo.audit(ctx.actor, 'DISPATCH_BLOCKED', id, { reasons: v.reasons }, now);
      continue;
    }
    const pubs = await ctx.repo.listPublications(id, b.version);
    const nowMs = Date.parse(now);
    for (const p of pubs) {
      if (![PS.READY, PS.SCHEDULED, PS.RETRY_PENDING].includes(p.status)) { run.skipped.push({ id: p.publication_id, reason: `estado ${p.status}` }); continue; }
      if (Date.parse(p.scheduled_at) > nowMs) { run.skipped.push({ id: p.publication_id, reason: 'aún no es la hora programada' }); continue; }
      if (p.next_retry_at && Date.parse(p.next_retry_at) > nowMs) { run.skipped.push({ id: p.publication_id, reason: `reintento programado ${p.next_retry_at}` }); continue; }
      if (budget <= 0) { run.skipped.push({ id: p.publication_id, reason: 'límite por ejecución alcanzado' }); continue; }
      const claimed = await ctx.repo.claimPublication(p.publication_id, now);
      if (!claimed) { run.skipped.push({ id: p.publication_id, reason: 'ya reclamada por otra ejecución' }); continue; }
      budget -= 1;
      const fresh = { ...p, claimed_from: p.status, status: PS.PUBLISHING, attempts: p.attempts + 1 };
      run.processed.push(await publishOne(fresh, ctx));
    }
    const after = await ctx.repo.listPublications(id, b.version);
    const statuses = after.map((p) => p.status);
    const untouched = statuses.every((s) => [PS.READY, PS.SCHEDULED, PS.CANCELLED].includes(s));
    const newStatus = untouched ? BS.APPROVED : aggregateBatchStatus(statuses);
    if (newStatus !== b.status) {
      await ctx.repo.updateBatchStatus(id, newStatus, ctx.now());
      if ([BS.COMPLETED, BS.FAILED, BS.PARTIALLY_COMPLETED].includes(newStatus)) {
        await releaseEncargoObjects(ctx, id);
      }
    }
    run.batch_status = newStatus;
  }
  await ctx.repo.audit(ctx.actor, 'DISPATCH_RUN', batchId ?? null, { trigger, batches: out.batches.map((x) => ({ id: x.batch_id, processed: x.processed.length, blocked: !!x.blocked })) }, ctx.now());
  return out;
}
