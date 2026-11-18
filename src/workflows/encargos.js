// Encargos de la persona (Access) y la cola que lee el bot. Sin UI.
import { err } from '../core/domain/errors.js';
import { BATCH_ID_RE } from '../core/domain/batch.js';
import { contentHash } from '../core/domain/hash.js';
import {
  assertAssetBytes, assertName, assertNoControlFields, assertPlatforms, assertSha256, assertTimeZone,
  civilDay, localTime, nextStreakCount, visibleStreak,
} from '../core/domain/encargos.js';
import { deleteAssetObjects } from './r2-gc.js';
import { completeUpload, createUpload } from './uploads.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_FOUND = () => err('NOT_FOUND', 'No encontrado', 404);

function requireGuide(user) {
  if (!user?.guide_seen_at) throw err('GUIDE_REQUIRED', 'Falta terminar la guía', 409);
}

function publicUser(user, accounts) {
  return {
    email: user.email,
    display_name: user.display_name,
    time_zone: user.time_zone,
    guide_pending: !user.guide_seen_at,
    accounts,
  };
}

function publicEncargo(row, assets = []) {
  const deliverable = assets
    .filter((asset) => asset.role === 'deliverable' && asset.version === row.version && !asset.delete_pending)
    .at(-1);
  return {
    encargo_id: row.encargo_id,
    account_id: row.account_id,
    kind: row.kind,
    note: row.note,
    status: row.status,
    platforms: row.platforms,
    version: row.version,
    content_hash: row.content_hash,
    synthetic: row.synthetic,
    publish_at: row.publish_at,
    batch_id: row.batch_id,
    preview: deliverable ? {
      sha256: deliverable.sha256,
      mime: deliverable.mime,
      size_bytes: deliverable.size_bytes,
      version: deliverable.version,
      media_url: `/v1/me/media/${deliverable.sha256}`,
    } : null,
  };
}

async function requireOwnedAccount(repo, email, accountId) {
  if (!UUID_RE.test(accountId ?? '')) throw NOT_FOUND();
  const account = await repo.ownedAccount(email, accountId);
  if (!account) throw NOT_FOUND();
  return account;
}

async function requireOwnedEncargo(repo, email, encargoId) {
  if (!UUID_RE.test(encargoId ?? '')) throw NOT_FOUND();
  const encargo = await repo.encargoForEmail(email, encargoId);
  if (!encargo) throw NOT_FOUND();
  return encargo;
}

export async function getMe(repo, { email, now }) {
  const user = await repo.ensureUser(email, now);
  return publicUser(user, await repo.listAccounts(user.user_id));
}

export async function saveGuide(repo, { email, body, now }) {
  assertNoControlFields(body);
  const displayName = assertName(body.display_name, 'Nombre');
  const timeZone = assertTimeZone(body.time_zone);
  const user = await repo.ensureUser(email, now);
  await repo.saveGuide(user.user_id, { displayName, timeZone, now });
  return getMe(repo, { email, now });
}

export async function renameMe(repo, { email, body, now }) {
  assertNoControlFields(body);
  const displayName = assertName(body.display_name, 'Nombre');
  const timeZone = body.time_zone === undefined ? null : assertTimeZone(body.time_zone);
  const user = await repo.ensureUser(email, now);
  requireGuide(user);
  await repo.renameUser(user.user_id, displayName, timeZone, now);
  return getMe(repo, { email, now });
}

export async function createAccount(repo, { email, body, now }) {
  assertNoControlFields(body);
  const name = assertName(body.name, 'Nombre');
  const user = await repo.ensureUser(email, now);
  requireGuide(user);
  return repo.createAccount(user.user_id, name, now);
}

export async function renameAccount(repo, { email, accountId, body, now }) {
  assertNoControlFields(body);
  const name = assertName(body.name, 'Nombre');
  await requireOwnedAccount(repo, email, accountId);
  return repo.renameAccount(accountId, name, now);
}

export async function createEncargo(repo, { email, body, now }) {
  assertNoControlFields(body);
  const account = await requireOwnedAccount(repo, email, body.account_id);
  requireGuide(account);
  const kind = body.kind;
  if (kind !== 'from_scratch' && kind !== 'edit') throw err('INVALID_INPUT', 'kind debe ser from_scratch o edit', 400);
  const platforms = assertPlatforms(body.platforms);
  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > 4000) throw err('INVALID_INPUT', 'La nota no es válida', 400);
    note = body.note.trim();
  }
  if (kind === 'from_scratch' && !note) throw err('INVALID_INPUT', 'Cuéntame la idea', 400);
  const status = kind === 'from_scratch' ? 'queued' : 'draft';
  const encargoId = await repo.insertEncargo({ accountId: account.account_id, kind, note, status, platforms, now });
  return { encargo_id: encargoId, account_id: account.account_id, kind, status };
}

export async function getEncargo(repo, { email, encargoId }) {
  const encargo = await requireOwnedEncargo(repo, email, encargoId);
  return publicEncargo(encargo, await repo.listAssets(encargoId));
}

async function assertBatchHash(repo, batchId) {
  const batch = await repo.getBatch(batchId);
  if (!batch) throw err('BATCH_NOT_FOUND', 'No existe el lote enlazado', 404);
  const recomputed = await contentHash(batch.payload);
  if (recomputed !== batch.content_hash) {
    throw err('HASH_MISMATCH', 'La huella almacenada del lote no coincide. Hay que reenviarlo.', 409);
  }
  return batch;
}

async function approveLinkedBatch(repo, encargo, now) {
  const batch = await assertBatchHash(repo, encargo.batch_id);
  const sameApproval = batch.status === 'APPROVED'
    && batch.approved_hash === batch.content_hash
    && Number(batch.approved_version) === Number(batch.version);
  if (!sameApproval) {
    if (batch.status !== 'READY_FOR_REVIEW' && batch.status !== 'APPROVED') {
      throw err('CONFLICT', 'El lote no está listo para aprobar', 409);
    }
    const ok = await repo.recordDecision({
      batchId: batch.batch_id, version: batch.version, hash: batch.content_hash, decision: 'APPROVE',
      decidedBy: encargo.email, keyId: 'access', commandText: `APROBAR ${batch.batch_id}`, comment: null,
      now, batchStatus: 'APPROVED', pubUpdates: [],
    });
    if (!ok) throw err('CONCURRENT_CHANGE', 'El lote cambió durante la aprobación', 409);
  }
  await repo.holdPublicationsUntilSchedule(batch.batch_id, batch.version, now);
}

export async function decideEncargo(repo, { email, encargoId, body, now, r2 }) {
  assertNoControlFields(body);
  const encargo = await requireOwnedEncargo(repo, email, encargoId);
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'changes') throw err('INVALID_INPUT', 'decision debe ser approve o changes', 400);
  const version = body.version;
  const reviewedHash = assertSha256(body.content_hash, 'content_hash');
  if (!Number.isInteger(version) || version !== encargo.version || reviewedHash !== encargo.content_hash) {
    throw err('VERSION_MISMATCH', 'La versión o la huella no coinciden', 409);
  }
  if (decision === 'approve') {
    if (encargo.batch_id) await approveLinkedBatch(repo, encargo, now);
    const ok = await repo.markApproved(encargo.encargo_id, encargo.account_id, version, reviewedHash, now);
    if (!ok) throw err('CONFLICT', 'Este encargo no está listo para aprobar', 409);
    return { encargo_id: encargo.encargo_id, status: 'approved', version };
  }
  const started = await repo.beginDiscard({
    encargoId: encargo.encargo_id,
    accountId: encargo.account_id,
    version,
    note: typeof body.note === 'string' && body.note.trim() && body.note.length <= 4000
      ? `${encargo.note ? `${encargo.note}\n\n` : ''}Cambios: ${body.note.trim()}`.slice(0, 4000)
      : null,
    now,
  });
  if (!started.changed) throw err('CONFLICT', 'Este encargo no admite cambios', 409);
  if (encargo.batch_id) await repo.invalidateBatchForChanges({ batchId: encargo.batch_id, now });
  const deleted = await deleteAssetObjects(repo, r2, started.rows, encargo.user_id);
  return { encargo_id: encargo.encargo_id, status: 'queued', bytes_released: deleted.bytes };
}

export async function cancelEncargo(repo, { email, encargoId, now, r2 }) {
  const encargo = await requireOwnedEncargo(repo, email, encargoId);
  if (encargo.status === 'cancelled') throw err('CONFLICT', 'El encargo ya está cancelado', 409);
  const started = await repo.beginCancel({
    encargoId: encargo.encargo_id, accountId: encargo.account_id, now,
  });
  if (!started.changed) throw err('CONFLICT', 'El encargo ya está cancelado', 409);
  if (encargo.batch_id) await repo.cancelLinkedBatch({ batchId: encargo.batch_id, now });
  const deleted = await deleteAssetObjects(repo, r2, started.rows, encargo.user_id);
  return { encargo_id: encargo.encargo_id, status: 'cancelled', bytes_released: deleted.bytes };
}

export async function scheduleEncargo(repo, { email, encargoId, body, now, dispatchBatch }) {
  assertNoControlFields(body);
  const encargo = await requireOwnedEncargo(repo, email, encargoId);
  if (encargo.status !== 'approved') throw err('CONFLICT', 'Solo se programa un encargo aprobado', 409);
  let publishAt;
  if (body.when === 'now') publishAt = now;
  else if (typeof body.when === 'string' && !Number.isNaN(Date.parse(body.when))) publishAt = new Date(body.when).toISOString();
  else throw err('INVALID_INPUT', 'when debe ser now o una hora', 400);
  if (encargo.batch_id) {
    const batch = await assertBatchHash(repo, encargo.batch_id);
    if (batch.status !== 'APPROVED' || batch.approved_hash !== batch.content_hash) {
      throw err('CONFLICT', 'El lote no está aprobado', 409);
    }
    await repo.schedulePublications({ batchId: batch.batch_id, version: batch.version, publishAt, now });
    await repo.audit(`access:${email}`, 'SCHEDULE_SET', batch.batch_id, { publish_at: publishAt, encargo_id: encargo.encargo_id }, now);
  }
  const ok = await repo.markScheduled(encargo.encargo_id, encargo.account_id, publishAt, encargo.platforms, now);
  if (!ok) throw err('CONFLICT', 'Solo se programa un encargo aprobado', 409);
  const today = civilDay(encargo.time_zone, now);
  const prev = await repo.streakRow(encargo.account_id);
  await repo.saveStreak(encargo.account_id, nextStreakCount(prev, today), today, now);
  if (body.when === 'now' && encargo.batch_id && dispatchBatch) await dispatchBatch(encargo.batch_id);
  return { encargo_id: encargo.encargo_id, status: 'scheduled', publish_at: publishAt };
}

export async function getStreak(repo, { email, accountId, now }) {
  const account = await requireOwnedAccount(repo, email, accountId);
  if (!account.time_zone) throw err('GUIDE_REQUIRED', 'Falta la zona horaria', 409);
  const today = civilDay(account.time_zone, now);
  const row = await repo.streakRow(account.account_id);
  return { account_id: account.account_id, time_zone: account.time_zone, ...visibleStreak(row, today) };
}

export async function getActivity(repo, { email, accountId }) {
  const account = await requireOwnedAccount(repo, email, accountId);
  const zone = account.time_zone ?? 'UTC';
  const rows = await repo.listActivity(account.account_id);
  return {
    account_id: account.account_id,
    time_zone: account.time_zone,
    activity: rows.map((row) => ({
      at: row.at,
      local_day: civilDay(zone, row.at),
      local_time: localTime(zone, row.at),
      kind: row.kind,
      encargo_id: row.encargo_id,
      platforms: row.detail?.platforms ?? null,
      mock_id: row.detail?.mock_id ?? null,
    })),
  };
}

export async function listConnections(repo, { email, accountId }) {
  const account = await requireOwnedAccount(repo, email, accountId);
  return { account_id: account.account_id, connections: await repo.listConnections(account.account_id) };
}

export async function getConnection(repo, { email, connectionId }) {
  if (!UUID_RE.test(connectionId ?? '')) throw NOT_FOUND();
  const row = await repo.connectionForEmail(email, connectionId);
  if (!row) throw NOT_FOUND();
  return row;
}

export async function listQueued(repo, status) {
  if (status !== 'queued') throw err('INVALID_INPUT', 'status=queued es obligatorio', 400);
  return { encargos: await repo.listQueuedEncargos() };
}

export async function claimEncargo(repo, { encargoId, now }) {
  if (!UUID_RE.test(encargoId ?? '')) throw NOT_FOUND();
  const ok = await repo.claimEncargo(encargoId, now);
  if (ok) return { encargo_id: encargoId, status: 'claimed' };
  const row = await repo.encargoById(encargoId);
  if (!row) throw NOT_FOUND();
  throw err('CONFLICT', 'El encargo no está en la cola', 409);
}

function assertR2Key(role, value) {
  if (typeof value !== 'string' || value.length < 5 || value.length > 200 || /\s/.test(value)) {
    throw err('INVALID_INPUT', 'Clave de objeto no válida', 400);
  }
  const prefix = role === 'source' ? 'src/' : 'out/';
  if (!value.startsWith(prefix)) throw err('INVALID_INPUT', 'Clave de objeto no válida', 400);
  return value;
}

function assertMime(value) {
  if (typeof value !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(value)) throw err('INVALID_INPUT', 'mime no válido', 400);
  return value;
}

export async function submitEncargoResult(repo, { encargoId, body, now }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw err('INVALID_INPUT', 'El cuerpo debe ser un objeto JSON', 400);
  for (const key of ['mode', 'live', 'publisher_mode']) {
    if (key in body) throw err('INVALID_INPUT', `Campo no permitido: ${key}`, 400);
  }
  if (!UUID_RE.test(encargoId ?? '')) throw NOT_FOUND();
  const encargo = await repo.encargoById(encargoId);
  if (!encargo) throw NOT_FOUND();
  if (encargo.status !== 'claimed') throw err('CONFLICT', 'El encargo no está reclamado', 409);
  if (typeof body.synthetic !== 'boolean') throw err('INVALID_INPUT', 'synthetic obligatorio', 400);
  if (encargo.kind === 'from_scratch' && body.synthetic !== true) {
    throw err('INVALID_INPUT', 'Un encargo desde cero es material generado', 400);
  }
  const contentHash = assertSha256(body.content_hash, 'content_hash');
  const version = encargo.delivered ? encargo.version + 1 : encargo.version;
  let batchId = null;
  if (body.batch_id !== undefined && body.batch_id !== null) {
    if (!BATCH_ID_RE.test(body.batch_id)) throw err('INVALID_INPUT', 'batch_id no válido', 400);
    const attached = await repo.attachBatchToAccount(body.batch_id, encargo.account_id);
    if (attached === 'missing') throw err('BATCH_NOT_FOUND', 'No existe ese lote', 404);
    if (attached === 'foreign') throw NOT_FOUND();
    batchId = body.batch_id;
  }
  const ok = await repo.finishEncargoResult({ encargoId, version, contentHash, synthetic: body.synthetic, batchId, now });
  if (!ok) throw err('CONFLICT', 'El encargo no está reclamado', 409);
  if (body.deliverable) {
    await repo.addEncargoAsset({
      encargoId: encargo.encargo_id,
      userId: encargo.user_id,
      role: 'deliverable',
      r2Key: assertR2Key('deliverable', body.deliverable.r2_key),
      sha256: assertSha256(body.deliverable.sha256, 'sha256'),
      mime: assertMime(body.deliverable.mime),
      sizeBytes: assertAssetBytes(body.deliverable.size_bytes),
      version,
      now,
    });
  }
  await repo.recordEncargoEvent(encargo.account_id, encargoId, now, 'ready', { version, synthetic: body.synthetic });
  return { encargo_id: encargoId, status: 'ready', version, content_hash: contentHash, synthetic: body.synthetic };
}

const PERSON_ROUTES = [
  ['GET', /^\/v1\/me$/, (repo, { email, now }) => getMe(repo, { email, now })],
  ['POST', /^\/v1\/me$/, (repo, { email, body, now }) => saveGuide(repo, { email, body, now })],
  ['PATCH', /^\/v1\/me$/, (repo, { email, body, now }) => renameMe(repo, { email, body, now })],
  ['POST', /^\/v1\/me\/accounts$/, (repo, { email, body, now }) => createAccount(repo, { email, body, now })],
  ['PATCH', /^\/v1\/me\/accounts\/([^/]+)$/, (repo, { email, body, now }, m) => renameAccount(repo, { email, accountId: m[1], body, now })],
  ['POST', /^\/v1\/me\/encargos$/, (repo, ctx) => createEncargo(repo, ctx)],
  ['GET', /^\/v1\/me\/encargos\/([^/]+)$/, (repo, { email }, m) => getEncargo(repo, { email, encargoId: m[1] })],
  ['POST', /^\/v1\/me\/uploads$/, (repo, ctx) => createUpload(repo, ctx)],
  ['POST', /^\/v1\/me\/uploads\/([^/]+)\/complete$/, (repo, ctx, m) => completeUpload(repo, { ...ctx, uploadId: m[1] })],
  ['POST', /^\/v1\/me\/encargos\/([^/]+)\/decision$/, (repo, ctx, m) => decideEncargo(repo, { ...ctx, encargoId: m[1] })],
  ['POST', /^\/v1\/me\/encargos\/([^/]+)\/cancel$/, (repo, ctx, m) => cancelEncargo(repo, { ...ctx, encargoId: m[1] })],
  ['POST', /^\/v1\/me\/encargos\/([^/]+)\/schedule$/, (repo, ctx, m) => scheduleEncargo(repo, { ...ctx, encargoId: m[1] })],
  ['GET', /^\/v1\/me\/accounts\/([^/]+)\/streak$/, (repo, { email, now }, m) => getStreak(repo, { email, accountId: m[1], now })],
  ['GET', /^\/v1\/me\/accounts\/([^/]+)\/activity$/, (repo, { email }, m) => getActivity(repo, { email, accountId: m[1] })],
  ['GET', /^\/v1\/me\/accounts\/([^/]+)\/connections$/, (repo, { email }, m) => listConnections(repo, { email, accountId: m[1] })],
  ['GET', /^\/v1\/me\/connections\/([^/]+)$/, (repo, { email }, m) => getConnection(repo, { email, connectionId: m[1] })],
];

export async function dispatchPerson(repo, ctx) {
  const route = PERSON_ROUTES.find(([method, re]) => method === ctx.method && re.test(ctx.pathname));
  if (!route) throw NOT_FOUND();
  return route[2](repo, ctx, route[1].exec(ctx.pathname));
}
