// WF-02 APPROVE_BATCH — registra una decisión EXPLÍCITA (aprobar / rechazar / pedir cambios)
// ligada a versión + huella. Solo accesible con la clave del aprobador (ver http/auth.js).
import { err } from '../core/domain/errors.js';
import { contentHash } from '../core/domain/hash.js';
import { BatchStatus as BS, PublicationStatus as PS, Decision } from '../core/domain/states.js';
import { summary } from './wf01-receive-batch.js';

const CMD_RE = /^(APROBAR|RECHAZAR|CAMBIOS)\s+(LOTE-[A-Z0-9-]+)\s*(?::\s*([\s\S]+))?$/;
const CMD_TO_DECISION = { APROBAR: Decision.APPROVE, RECHAZAR: Decision.REJECT, CAMBIOS: Decision.REQUEST_CHANGES };

export function parseDecisionCommand(text) {
  const m = CMD_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  return { decision: CMD_TO_DECISION[m[1]], batch_id: m[2], comment: m[3]?.trim() || null };
}

export async function decideBatch(batchId, body, ctx) {
  const now = ctx.now();
  if (ctx.keyId !== 'approver') throw err('FORBIDDEN', 'Las decisiones requieren la clave del aprobador', 403);
  const cmd = parseDecisionCommand(body?.command_text);
  if (!cmd) throw err('INVALID_COMMAND', 'command_text debe ser "APROBAR LOTE-XXXX", "RECHAZAR LOTE-XXXX" o "CAMBIOS LOTE-XXXX: ..."', 400);
  if (cmd.batch_id !== batchId) throw err('INVALID_COMMAND', `El comando se refiere a ${cmd.batch_id}, no a ${batchId}`, 400);
  if (typeof body.decided_by !== 'string' || !body.decided_by.trim()) throw err('INVALID_DECISION', 'decided_by obligatorio', 400);
  if (!Number.isInteger(body.version)) throw err('INVALID_DECISION', 'version obligatoria (la versión revisada)', 400);
  if (!/^[a-f0-9]{64}$/.test(body.content_hash ?? '')) throw err('INVALID_DECISION', 'content_hash obligatorio (la huella revisada)', 400);
  if (cmd.decision === Decision.REQUEST_CHANGES && !cmd.comment) throw err('INVALID_DECISION', 'CAMBIOS requiere descripción de las modificaciones', 400);

  const b = await ctx.repo.getBatch(batchId);
  if (!b) throw err('BATCH_NOT_FOUND', `No existe ${batchId}`, 404);
  if (![BS.READY_FOR_REVIEW, BS.APPROVED, BS.CHANGES_REQUESTED].includes(b.status)) {
    throw err('INVALID_STATE', `No se puede decidir sobre un lote en estado ${b.status}`, 409);
  }
  if (body.version !== b.version) throw err('VERSION_MISMATCH', `Versión revisada ${body.version} != versión actual ${b.version}. Revisa la versión nueva.`, 409, { current_version: b.version });
  if (body.content_hash !== b.content_hash) throw err('HASH_MISMATCH', 'La huella revisada no coincide con la actual', 409, { current_hash: b.content_hash });
  const recomputed = await contentHash(b.payload);
  if (recomputed !== b.content_hash) throw err('INTEGRITY_ERROR', 'El contenido almacenado no coincide con su huella', 500);
  if (cmd.decision === Decision.APPROVE && b.status === BS.CHANGES_REQUESTED) {
    throw err('INVALID_STATE', 'Se pidieron cambios en esta versión; hace falta una versión nueva antes de aprobar', 409);
  }

  const pubs = await ctx.repo.listPublications(batchId, b.version);
  const nowMs = Date.parse(now);
  const pubUpdates = [];
  for (const p of pubs) {
    if (cmd.decision === Decision.APPROVE && [PS.VALIDATED].includes(p.status)) {
      pubUpdates.push({ id: p.publication_id, from: p.status, to: Date.parse(p.scheduled_at) <= nowMs ? PS.READY : PS.SCHEDULED });
    } else if (cmd.decision === Decision.REJECT && p.status !== PS.CANCELLED) {
      pubUpdates.push({ id: p.publication_id, from: p.status, to: PS.CANCELLED });
    } else if (cmd.decision === Decision.REQUEST_CHANGES && [PS.READY, PS.SCHEDULED].includes(p.status)) {
      pubUpdates.push({ id: p.publication_id, from: p.status, to: PS.VALIDATED });
    }
  }
  const batchStatus = { APPROVE: BS.APPROVED, REJECT: BS.REJECTED, REQUEST_CHANGES: BS.CHANGES_REQUESTED }[cmd.decision];
  const ok = await ctx.repo.recordDecision({
    batchId, version: b.version, hash: b.content_hash, decision: cmd.decision, decidedBy: body.decided_by.trim(),
    keyId: ctx.keyId, commandText: body.command_text, comment: cmd.comment, now, batchStatus, pubUpdates,
  });
  if (!ok) throw err('CONCURRENT_CHANGE', 'El lote cambió durante la decisión; vuelve a revisarlo', 409);
  await ctx.repo.audit(`approver:${body.decided_by.trim()}`, `DECISION_${cmd.decision}`, batchId, { version: b.version, hash: b.content_hash, comment: cmd.comment }, now);
  const saved = await ctx.repo.getBatch(batchId);
  return { decision: cmd.decision, confirmed_by: 'orchestrator-d1', ...summary(saved) };
}
