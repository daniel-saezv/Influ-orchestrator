// Encargos de la persona (Access) y la cola que lee el bot. Sin UI.
import { err } from '../core/domain/errors.js';
import { BATCH_ID_RE } from '../core/domain/batch.js';
import { contentHash } from '../core/domain/hash.js';
import {
  assertName, assertNoControlFields, assertSha256, assertTimeZone,
  civilDay, localTime, nextStreakCount, visibleStreak,
} from '../core/domain/encargos.js';
import { assertEncargoSelection } from '../core/domain/formats.js';
import { MAX_CLASS_B_GLOBAL, MAX_CLASS_B_USER } from '../core/domain/r2-quota.js';
import { PRESIGN_TTL_SECONDS, signingUnavailableError } from '../adapters/storage/r2-presign.js';
import { deleteAssetObjects, releaseReservationHold } from './r2-gc.js';
import { completeUpload, createUpload, etagMatches, releaseUpload } from './uploads.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_FOUND = () => err('NOT_FOUND', 'No encontrado', 404);

function requireGuide(user) {
  if (!user?.guide_seen_at) throw err('GUIDE_REQUIRED', 'Falta terminar la guía', 409);
}

function accountsWithStreak(accounts, timeZone, now) {
  const today = timeZone ? civilDay(timeZone, now) : null;
  return accounts.map((account) => {
    const row = account.streak_count == null
      ? null
      : { count: account.streak_count, last_civil_day: account.last_civil_day };
    return {
      account_id: account.account_id,
      name: account.name,
      streak_days: today ? visibleStreak(row, today).count : 0,
    };
  });
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

function currentDeliverable(row, assets = []) {
  return assets
    .filter((asset) => asset.role === 'deliverable' && asset.version === row.version && !asset.delete_pending)
    .at(-1);
}

function encargoEtag(row, assets = []) {
  const deliverable = currentDeliverable(row, assets);
  return `"${row.updated_at}:${row.version}:${row.status}:${row.content_hash ?? ''}:${deliverable?.sha256 ?? ''}"`;
}

const PERSON_JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-influ-mode': 'mock',
};

function publicEncargo(row, assets = []) {
  const deliverable = currentDeliverable(row, assets);
  return {
    encargo_id: row.encargo_id,
    account_id: row.account_id,
    kind: row.kind,
    note: row.note,
    status: row.status,
    platforms: row.platforms,
    format: row.format ?? null,
    targets: row.targets ?? null,
    legacy: row.legacy === true || row.format == null,
    version: row.version,
    content_hash: row.content_hash,
    synthetic: row.synthetic,
    publish_at: row.publish_at,
    batch_id: row.batch_id,
    account_name: row.account_name ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
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
  const accounts = await repo.listAccounts(user.user_id);
  return publicUser(user, accountsWithStreak(accounts, user.time_zone, now));
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
  const { format, targets, platforms } = assertEncargoSelection(body);
  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > 4000) throw err('INVALID_INPUT', 'La nota no es válida', 400);
    note = body.note.trim();
  }
  if (kind === 'from_scratch' && !note) throw err('INVALID_INPUT', 'Cuéntame la idea', 400);
  const status = kind === 'from_scratch' ? 'queued' : 'draft';
  const encargoId = await repo.insertEncargo({ accountId: account.account_id, kind, note, status, platforms, format, targets, now });
  return {
    encargo_id: encargoId, account_id: account.account_id, kind, status, platforms, format, targets, legacy: false,
  };
}

export async function listEncargos(repo, { email, now }) {
  await repo.ensureUser(email, now);
  const rows = await repo.listEncargosForEmail(email);
  const deliverables = await repo.listCurrentDeliverablesForEmail(email);
  const assetsByEncargo = new Map();
  for (const asset of deliverables) {
    const bucket = assetsByEncargo.get(asset.encargo_id);
    if (bucket) bucket.push(asset);
    else assetsByEncargo.set(asset.encargo_id, [asset]);
  }
  return { encargos: rows.map((row) => publicEncargo(row, assetsByEncargo.get(row.encargo_id) ?? [])) };
}

async function loadPublicEncargo(repo, email, encargoId) {
  const encargo = await requireOwnedEncargo(repo, email, encargoId);
  const assets = await repo.listPreviewAssets(encargo.encargo_id, encargo.version);
  return { encargo, assets, data: publicEncargo(encargo, assets) };
}

export async function getEncargo(repo, { email, encargoId }) {
  return (await loadPublicEncargo(repo, email, encargoId)).data;
}

export async function getEncargoHttpResponse(repo, { email, encargoId, request }) {
  const { encargo, assets, data } = await loadPublicEncargo(repo, email, encargoId);
  const etag = encargoEtag(encargo, assets);
  if (etagMatches(request?.headers?.get?.('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: { etag, ...PERSON_JSON_HEADERS } });
  }
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { etag, ...PERSON_JSON_HEADERS },
  });
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
  return { encargo_id: encargo.encargo_id, kind: encargo.kind, status: 'queued', bytes_released: deleted.bytes };
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

async function verifyStoredSource(repo, r2, encargo, assets, now) {
  if (!assets.length) return;
  if (!r2) throw err('R2_UNAVAILABLE', 'El almacenamiento no está disponible', 503);
  for (const asset of assets) {
    const reserved = await repo.reserveDaily(encargo.user_id, 'b', now, MAX_CLASS_B_USER, MAX_CLASS_B_GLOBAL);
    if (!reserved) throw err('QUOTA_EXCEEDED', 'Tope de lecturas alcanzado', 413);
    let head;
    try {
      head = await r2.head(asset.r2_key);
    } catch {
      await repo.releaseDaily(encargo.user_id, 'b', now);
      throw err('R2_UNAVAILABLE', 'No se pudo comprobar el origen', 503);
    }
    if (!head || head.sha256 !== asset.sha256 || Number(head.size) !== Number(asset.size_bytes)) {
      throw err('INTEGRITY_PART_MISMATCH', 'La parte almacenada no coincide', 409);
    }
  }
}

export async function retryEncargo(repo, { email, encargoId, body, now, r2 }) {
  if (body != null) assertNoControlFields(body);
  const encargo = await requireOwnedEncargo(repo, email, encargoId);
  if (encargo.status !== 'failed') throw err('CONFLICT', 'Solo se puede reintentar un encargo fallido', 409);
  const assets = await repo.listSourceAssets(encargo.encargo_id);
  if (encargo.kind === 'edit' && assets.length === 0) {
    throw err('CONFLICT', 'No quedan archivos de origen para reintentar', 409);
  }
  await verifyStoredSource(repo, r2, encargo, assets, now);
  const open = await repo.listOpenReservations(encargo.encargo_id);
  for (const row of open) await releaseReservationHold(repo, row, now);
  const ok = await repo.requeueFailedEncargo(encargo.encargo_id, now);
  if (!ok) throw err('CONFLICT', 'Solo se puede reintentar un encargo fallido', 409);
  await repo.recordEncargoEvent(encargo.account_id, encargo.encargo_id, now, 'retried', { assets: assets.length });
  await repo.audit(`access:${email}`, 'ENCARGO_RETRIED', null, {
    encargo_id: encargo.encargo_id,
    account_id: encargo.account_id,
    assets: assets.length,
  }, now);
  const fresh = await repo.encargoForEmail(email, encargo.encargo_id);
  return publicEncargo(fresh, []);
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
  const streakDays = nextStreakCount(prev, today);
  await repo.saveStreak(encargo.account_id, streakDays, today, now);
  if (body.when === 'now' && encargo.batch_id && dispatchBatch) await dispatchBatch(encargo.batch_id);
  return { encargo_id: encargo.encargo_id, status: 'scheduled', publish_at: publishAt, streak_days: streakDays };
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

function presentBotEncargo(row, fileSha, assets) {
  return {
    encargo_id: row.encargo_id,
    account_id: row.account_id,
    account_name: row.account_name,
    kind: row.kind,
    note: row.note,
    status: row.status,
    platforms: row.platforms,
    format: row.format ?? null,
    targets: row.targets ?? null,
    legacy: row.legacy === true || row.format == null,
    version: row.version,
    file_sha256: fileSha,
    assets,
  };
}

async function botEncargo(repo, encargoId) {
  const row = await repo.encargoById(encargoId);
  if (!row) return null;
  const [fileSha, assets] = await Promise.all([
    repo.sourceFileSha(encargoId),
    repo.listSourceAssets(encargoId),
  ]);
  return presentBotEncargo(row, fileSha, assets);
}

export async function reviewEncargoForBot(repo, encargoId) {
  if (!UUID_RE.test(encargoId ?? '')) throw NOT_FOUND();
  const row = await repo.encargoById(encargoId);
  if (!row) throw NOT_FOUND();
  const [fileSha, assets] = await Promise.all([
    repo.sourceFileSha(encargoId),
    repo.listSourceAssets(encargoId),
  ]);
  return {
    ...presentBotEncargo(row, fileSha, assets),
    content_hash: row.content_hash ?? null,
    synthetic: row.synthetic,
  };
}

export async function readClaimedOrigin(repo, { encargoId, now, r2, signer = null, env = null, actor = 'mcp' }) {
  if (!UUID_RE.test(encargoId ?? '')) throw NOT_FOUND();
  const row = await repo.encargoById(encargoId);
  if (!row) throw NOT_FOUND();
  if (row.status !== 'claimed') throw err('CONFLICT', 'El encargo no está reclamado', 409);
  const [assets, fileSha] = await Promise.all([
    repo.listSourceAssets(encargoId),
    repo.sourceFileSha(encargoId),
  ]);
  const activeSigner = assets.length ? (signer ?? null) : null;
  if (assets.length && !activeSigner) throw signingUnavailableError(env);
  const expiry = new Date(Date.parse(now) + PRESIGN_TTL_SECONDS * 1000).toISOString();
  const checked = [];
  for (const asset of assets) {
    if (!r2) throw err('R2_UNAVAILABLE', 'El almacenamiento no está disponible', 503);
    const reserved = await repo.reserveDaily(row.user_id, 'b', now, MAX_CLASS_B_USER, MAX_CLASS_B_GLOBAL);
    if (!reserved) throw err('QUOTA_EXCEEDED', 'Tope de lecturas alcanzado', 413);
    let head;
    try {
      head = await r2.head(asset.r2_key);
    } catch {
      await repo.releaseDaily(row.user_id, 'b', now);
      throw err('R2_UNAVAILABLE', 'No se pudo leer el origen', 503);
    }
    checked.push({
      r2_key: asset.r2_key,
      sha256: asset.sha256,
      mime: asset.mime,
      size_bytes: Number(asset.size_bytes),
      stored_sha256: head?.sha256 ?? null,
      stored_size: head ? Number(head.size) : null,
      matches: Boolean(head && head.sha256 === asset.sha256 && Number(head.size) === Number(asset.size_bytes)),
    });
  }
  const signedGets = [];
  for (const asset of checked) {
    const reservedGet = await repo.reserveDaily(row.user_id, 'b', now, MAX_CLASS_B_USER, MAX_CLASS_B_GLOBAL);
    if (!reservedGet) {
      for (let i = 0; i < signedGets.length; i += 1) await repo.releaseDaily(row.user_id, 'b', now);
      throw err('QUOTA_EXCEEDED', 'Tope de lecturas alcanzado', 413);
    }
    try {
      asset.url = await activeSigner.signGet(asset.r2_key, PRESIGN_TTL_SECONDS);
      asset.expires_at = expiry;
      signedGets.push(asset);
    } catch (error) {
      await repo.releaseDaily(row.user_id, 'b', now);
      for (const done of signedGets) {
        await repo.releaseDaily(row.user_id, 'b', now);
        delete done.url;
        delete done.expires_at;
      }
      throw error;
    }
  }
  await repo.audit(actor, 'ENCARGO_ORIGIN_READ', null, {
    encargo_id: encargoId, account_id: row.account_id, assets: checked.length,
  }, now);
  return {
    encargo_id: row.encargo_id,
    account_id: row.account_id,
    kind: row.kind,
    note: row.note,
    status: row.status,
    platforms: row.platforms,
    format: row.format ?? null,
    targets: row.targets ?? null,
    legacy: row.legacy === true || row.format == null,
    version: row.version,
    file_sha256: fileSha,
    assets: checked,
  };
}

export async function claimEncargo(repo, {
  encargoId, now, actor = 'grok-bot', withOrigin = false, r2 = null, signer = null, env = null,
}) {
  if (!UUID_RE.test(encargoId ?? '')) throw NOT_FOUND();
  const ok = await repo.claimEncargo(encargoId, now);
  if (!ok) {
    const row = await repo.encargoById(encargoId);
    if (!row) throw NOT_FOUND();
    throw err('CONFLICT', 'El encargo no está en la cola', 409);
  }
  const encargo = await botEncargo(repo, encargoId);
  await repo.audit(actor, 'ENCARGO_CLAIMED', null, { encargo_id: encargoId, account_id: encargo.account_id }, now);
  const result = { encargo_id: encargoId, status: 'claimed', encargo };
  if (withOrigin) {
    result.origin = await readClaimedOrigin(repo, { encargoId, now, r2, signer, env, actor });
  }
  return result;
}

function failureMessage(code) {
  if (code === 'INTEGRITY_PART_MISMATCH') return 'La parte almacenada no coincide';
  if (code === 'INTEGRITY_FILE_MISMATCH') return 'El SHA-256 del archivo no coincide';
  return 'El origen no supera la comprobación';
}

function failureCode(body) {
  const code = body?.error?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
  return 'INTEGRITY_ERROR';
}

async function markFailed(repo, encargo, now, actor, code) {
  const ok = await repo.failEncargo(encargo.encargo_id, now);
  if (!ok) throw err('CONFLICT', 'El encargo no está reclamado', 409);
  const detail = { encargo_id: encargo.encargo_id, account_id: encargo.account_id, code };
  await repo.audit(actor, 'ENCARGO_FAILED', null, detail, now);
  await repo.recordEncargoEvent(encargo.account_id, encargo.encargo_id, now, 'failed', { code });
  throw err(code, failureMessage(code), 409, { encargo_id: encargo.encargo_id, status: 'failed' });
}

// head de cada parte (clase B) y comparación del SHA-256 anunciado. El Worker no hashea el cuerpo.
async function checkSourceIntegrity(repo, r2, encargo, body, now, actor) {
  const assets = await repo.listSourceAssets(encargo.encargo_id);
  if (!assets.length) return;
  const announcedPromise = repo.sourceFileSha(encargo.encargo_id).catch((error) => error);
  if (!r2) throw err('R2_UNAVAILABLE', 'El almacenamiento no está disponible', 503);
  for (const asset of assets) {
    const reserved = await repo.reserveDaily(encargo.user_id, 'b', now, MAX_CLASS_B_USER, MAX_CLASS_B_GLOBAL);
    if (!reserved) throw err('QUOTA_EXCEEDED', 'Tope de lecturas alcanzado', 413);
    let head;
    try {
      head = await r2.head(asset.r2_key);
    } catch {
      await repo.releaseDaily(encargo.user_id, 'b', now);
      throw err('R2_UNAVAILABLE', 'No se pudo comprobar el origen', 503);
    }
    if (!head || head.sha256 !== asset.sha256 || Number(head.size) !== Number(asset.size_bytes)) {
      await markFailed(repo, encargo, now, actor, 'INTEGRITY_PART_MISMATCH');
    }
  }
  const announced = await announcedPromise;
  if (announced instanceof Error) throw announced;
  const reported = typeof body.file_sha256 === 'string' ? body.file_sha256.trim().toLowerCase() : '';
  const reportedOk = /^[a-f0-9]{64}$/.test(reported);
  if (body.failed === true && !reportedOk) await markFailed(repo, encargo, now, actor, failureCode(body));
  if (!reportedOk) throw err('INVALID_INPUT', 'file_sha256 debe ser un SHA-256 en hex', 400);
  const single = assets.length === 1 ? assets[0].sha256 : null;
  if (!announced || reported !== announced || (single && single !== announced)) {
    await markFailed(repo, encargo, now, actor, 'INTEGRITY_FILE_MISMATCH');
  }
}

async function loadDeliverable(repo, r2, encargo, body, version, now) {
  if (body.deliverable == null) return null;
  if (typeof body.deliverable !== 'object' || Array.isArray(body.deliverable) || typeof body.deliverable.r2_key !== 'string') {
    throw err('INVALID_INPUT', 'La clave no corresponde a una subida preparada', 400);
  }
  const row = await repo.reservationForEncargo(encargo.encargo_id, body.deliverable.r2_key);
  if (!row || row.consumed_at || row.released_at || Number(row.version) !== version || !String(row.r2_key).startsWith('out/')) {
    throw err('INVALID_INPUT', 'La clave no corresponde a una subida preparada', 400);
  }
  if (!r2) throw err('R2_UNAVAILABLE', 'El almacenamiento no está disponible', 503);
  const reserved = await repo.reserveDaily(encargo.user_id, 'b', now, MAX_CLASS_B_USER, MAX_CLASS_B_GLOBAL);
  if (!reserved) throw err('QUOTA_EXCEEDED', 'Tope de lecturas alcanzado', 413);
  let head;
  try {
    head = await r2.head(row.r2_key);
  } catch {
    await repo.releaseDaily(encargo.user_id, 'b', now);
    throw err('R2_UNAVAILABLE', 'No se pudo comprobar la pieza', 503);
  }
  if (!head || Number(head.size) !== Number(row.size_bytes) || !head.md5 || head.md5 !== row.content_md5) {
    throw err('INTEGRITY_ERROR', 'La pieza almacenada no coincide', 409);
  }
  return row;
}

export async function submitEncargoResult(repo, { encargoId, body, now, r2 = null, actor = 'grok-bot' }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw err('INVALID_INPUT', 'El cuerpo debe ser un objeto JSON', 400);
  for (const key of ['mode', 'live', 'publisher_mode']) {
    if (key in body) throw err('INVALID_INPUT', `Campo no permitido: ${key}`, 400);
  }
  if (!UUID_RE.test(encargoId ?? '')) throw NOT_FOUND();
  const encargo = await repo.encargoById(encargoId);
  if (!encargo) throw NOT_FOUND();
  if (encargo.status !== 'claimed') throw err('CONFLICT', 'El encargo no está reclamado', 409);
  await checkSourceIntegrity(repo, r2, encargo, body, now, actor);
  if (body.failed === true) await markFailed(repo, encargo, now, actor, failureCode(body));
  if (typeof body.synthetic !== 'boolean') throw err('INVALID_INPUT', 'synthetic obligatorio', 400);
  if (encargo.kind === 'from_scratch' && body.synthetic !== true) {
    throw err('INVALID_INPUT', 'Un encargo desde cero es material generado', 400);
  }
  const contentHash = assertSha256(body.content_hash, 'content_hash');
  const version = encargo.delivered ? Number(encargo.version) + 1 : Number(encargo.version);
  const deliverable = await loadDeliverable(repo, r2, encargo, body, version, now);
  let batchId = null;
  if (body.batch_id !== undefined && body.batch_id !== null) {
    if (!BATCH_ID_RE.test(body.batch_id)) throw err('INVALID_INPUT', 'batch_id no válido', 400);
    const attached = await repo.attachBatchToAccount(body.batch_id, encargo.account_id);
    if (attached === 'missing') throw err('BATCH_NOT_FOUND', 'No existe ese lote', 404);
    if (attached === 'foreign') throw NOT_FOUND();
    batchId = body.batch_id;
  }
  let consumedAt = null;
  if (deliverable) {
    consumedAt = now;
    const consumed = await repo.markReservationConsumed(deliverable.reservation_id, consumedAt);
    if (!consumed) throw err('CONFLICT', 'La reserva de subida ya no está disponible', 409);
  }
  const ok = await repo.finishEncargoResult({ encargoId, version, contentHash, synthetic: body.synthetic, batchId, now });
  if (!ok) {
    if (deliverable) await repo.reopenReservation(deliverable.reservation_id, consumedAt);
    throw err('CONFLICT', 'El encargo no está reclamado', 409);
  }
  if (deliverable) {
    await repo.addEncargoAsset({
      encargoId: encargo.encargo_id,
      userId: encargo.user_id,
      role: 'deliverable',
      r2Key: deliverable.r2_key,
      sha256: deliverable.sha256,
      mime: deliverable.mime,
      sizeBytes: Number(deliverable.size_bytes),
      version,
      now,
      contentMd5: deliverable.content_md5,
      countBytes: false,
    });
  }
  await repo.recordEncargoEvent(encargo.account_id, encargoId, now, 'ready', { version, synthetic: body.synthetic });
  await repo.audit(actor, 'ENCARGO_RESULT', batchId, {
    encargo_id: encargoId, account_id: encargo.account_id, synthetic: body.synthetic, version,
  }, now);
  return { encargo_id: encargoId, status: 'ready', version, content_hash: contentHash, synthetic: body.synthetic };
}

const PERSON_ROUTES = [
  ['GET', /^\/v1\/me$/, (repo, { email, now }) => getMe(repo, { email, now })],
  ['POST', /^\/v1\/me$/, (repo, { email, body, now }) => saveGuide(repo, { email, body, now })],
  ['PATCH', /^\/v1\/me$/, (repo, { email, body, now }) => renameMe(repo, { email, body, now })],
  ['POST', /^\/v1\/me\/accounts$/, (repo, { email, body, now }) => createAccount(repo, { email, body, now })],
  ['PATCH', /^\/v1\/me\/accounts\/([^/]+)$/, (repo, { email, body, now }, m) => renameAccount(repo, { email, accountId: m[1], body, now })],
  ['POST', /^\/v1\/me\/encargos$/, (repo, ctx) => createEncargo(repo, ctx)],
  ['GET', /^\/v1\/me\/encargos$/, (repo, { email, now }) => listEncargos(repo, { email, now })],
  ['GET', /^\/v1\/me\/encargos\/([^/]+)$/, (repo, { email }, m) => getEncargo(repo, { email, encargoId: m[1] })],
  ['POST', /^\/v1\/me\/uploads$/, (repo, ctx) => createUpload(repo, ctx)],
  ['POST', /^\/v1\/me\/uploads\/([^/]+)\/complete$/, (repo, ctx, m) => completeUpload(repo, { ...ctx, uploadId: m[1] })],
  ['POST', /^\/v1\/me\/uploads\/([^/]+)\/release$/, (repo, ctx, m) => releaseUpload(repo, { ...ctx, uploadId: m[1] })],
  ['POST', /^\/v1\/me\/encargos\/([^/]+)\/decision$/, (repo, ctx, m) => decideEncargo(repo, { ...ctx, encargoId: m[1] })],
  ['POST', /^\/v1\/me\/encargos\/([^/]+)\/cancel$/, (repo, ctx, m) => cancelEncargo(repo, { ...ctx, encargoId: m[1] })],
  ['POST', /^\/v1\/me\/encargos\/([^/]+)\/retry$/, (repo, ctx, m) => retryEncargo(repo, { ...ctx, encargoId: m[1] })],
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
