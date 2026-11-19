// Punto de entrada del Worker "influ-poc-orchestrator".
// Capa HTTP (Webhooks autenticados) + Cron Trigger. Solo compone puertos y adaptadores;
// la lógica vive en src/workflows (WF-01..04) y src/core.
import { DomainError, err } from './core/domain/errors.js';
import { sha256Hex } from './core/domain/hash.js';
import { runtimeSettings, LIVE_ENABLED_IN_BUILD } from './core/config.js';
import { createPublisherRegistry } from './adapters/publishers/registry.js';
import { D1Repository } from './adapters/repository/d1-repository.js';
import { D1MockProviderStore } from './adapters/repository/d1-mock-provider-store.js';
import { KvMediaStorage } from './adapters/storage/kv-media-storage.js';
import { R2ObjectStore } from './adapters/storage/r2-object-store.js';
import { verifyRequest } from './adapters/http/auth.js';
import { applyHttpRateLimit, isAuthenticatedAttempt, purgeOldRateWindows } from './adapters/http/rate-limit.js';
import { omitAccessClientSecret, verifyAccessJwt, verifyMcpServiceToken, teamDomainHostname } from './adapters/http/access-jwt.js';
import { allowEgressHost } from './adapters/http/egress-guard.js';
import { installEgressGuard, drainEgressAttempts } from './adapters/http/egress-guard.js';
import { receiveBatch } from './workflows/wf01-receive-batch.js';
import { decideBatch } from './workflows/wf02-approve-batch.js';
import { dispatch, publishBatchNow } from './workflows/wf03-schedule-dispatch.js';
import { buildReview, buildResults } from './workflows/reports.js';
import { normalizeEmail } from './core/domain/encargos.js';
import { claimEncargo, dispatchPerson, getEncargoHttpResponse, listQueued, submitEncargoResult } from './workflows/encargos.js';
import { reviewUnclaimedQueue } from './workflows/encargo-backup.js';
import { getMediaResponse, putUploadPart } from './workflows/uploads.js';
import { deleteOrphanUploads, releaseExpiredReservations, retryPendingDeletes } from './workflows/r2-gc.js';
import { mcpBearerOk } from './adapters/mcp/bearer.js';
import { MCP_PATH, createInfluMcpHandler } from './adapters/mcp/influ-mcp.js';
import { notifyEncargoQueued } from './adapters/http/encargo-webhook.js';

export const SERVICE_VERSION = '0.1.0';
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const PERSON_BODY_MAX = 65_536;

let accessJwtDeps = {};
/** Solo para pruebas: inyecta las claves de Access sin salir a la red. */
export function setAccessJwtDeps(deps) { accessJwtDeps = deps ?? {}; }

function isPersonRoute(pathname) {
  return pathname === '/v1/me' || pathname.startsWith('/v1/me/');
}

function isMcpRoute(pathname) {
  return pathname === MCP_PATH;
}

async function handleMcp(request, env, ctx) {
  try {
    await verifyMcpServiceToken(request, env, accessJwtDeps);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'UNAUTHENTICATED') {
      await applyHttpRateLimit(request, env, { scope: 'anon' });
    }
    throw error;
  }
  const ok = await mcpBearerOk(request, env.MCP_BEARER_TOKEN);
  if (!ok) {
    await applyHttpRateLimit(request, env, { scope: 'anon' });
    return json(401, { ok: false, error: { code: 'UNAUTHENTICATED', message: 'MCP no autorizado' } });
  }
  return createInfluMcpHandler(env)(omitAccessClientSecret(request), env, ctx);
}

async function maybeNotifyEncargo(env, ctx, method, data) {
  if (method === 'GET' || method === 'HEAD' || data?.status !== 'queued' || !data?.encargo_id || !data?.kind) return;
  const task = notifyEncargoQueued(env, {
    encargo_id: data.encargo_id, kind: data.kind, status: data.status,
  }).then((result) => {
    if (result.sent || result.reason === 'absent') return;
    console.info(JSON.stringify({ event: 'encargo_webhook_failed', encargo_id: data.encargo_id, reason: result.reason }));
  }).catch(() => {
    console.info(JSON.stringify({ event: 'encargo_webhook_failed', encargo_id: data.encargo_id, reason: 'error' }));
  });
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(task);
  else await task;
}

// En MOCK la lista de hosts permitidos está vacía: ninguna salida a Internet.
installEgressGuard(() => []);

function buildCtx(env, { actor, keyId }) {
  const repo = new D1Repository(env.DB);
  const settings = runtimeSettings(env);
  return {
    repo, settings, actor, keyId,
    media: new KvMediaStorage(env.MEDIA, env.DB),
    r2: env.MEDIA_R2 ? new R2ObjectStore(env.MEDIA_R2) : null,
    get registry() { // perezoso: si la config de modo es inválida, solo fallan las operaciones que la usan
      if (!this._registry) this._registry = createPublisherRegistry(env, { store: new D1MockProviderStore(env.DB), maxBytes: MAX_MEDIA_BYTES });
      return this._registry;
    },
    now: () => new Date().toISOString(),
  };
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-influ-mode': 'mock' },
});

async function flushEgress(repo, context) {
  const a = drainEgressAttempts();
  if (a.length) await repo.logEgress(a.map((x) => ({ ...x, context })));
}

const ROUTES = [
  // [método, patrón, claves permitidas, manejador]
  ['GET', /^\/v1\/batches$/, ['bot'], async (ctx) => ({ batches: await ctx.repo.listBatches() })],
  ['POST', /^\/v1\/batches$/, ['bot'], async (ctx, m, body) => receiveBatch(body, ctx, { mode: 'create' })],
  ['PUT', /^\/v1\/batches\/(LOTE-[A-Z0-9-]+)$/, ['bot'], async (ctx, m, body) => {
    if (body?.batch_id !== m[1]) throw err('INVALID_BATCH', 'batch_id del cuerpo no coincide con la URL', 400);
    const { change_note, ...rest } = body;
    return receiveBatch(rest, ctx, { mode: 'update', note: change_note });
  }],
  ['GET', /^\/v1\/batches\/(LOTE-[A-Z0-9-]+)$/, ['bot', 'approver'], async (ctx, m) => {
    const b = await ctx.repo.getBatch(m[1]);
    if (!b) throw err('BATCH_NOT_FOUND', `No existe ${m[1]}`, 404);
    const pubs = await ctx.repo.listPublications(m[1], b.version);
    const { payload, ...rest } = b;
    return { ...rest, publications: pubs.map((p) => ({ publication_id: p.publication_id, seq: p.seq, status: p.status, attempts: p.attempts, provider_post_id: p.provider_post_id })) };
  }],
  ['GET', /^\/v1\/batches\/(LOTE-[A-Z0-9-]+)\/review$/, ['bot', 'approver'], async (ctx, m) => buildReview(m[1], ctx)],
  ['POST', /^\/v1\/batches\/(LOTE-[A-Z0-9-]+)\/decision$/, ['approver'], async (ctx, m, body) => decideBatch(m[1], body, ctx)],
  ['POST', /^\/v1\/batches\/(LOTE-[A-Z0-9-]+)\/publish$/, ['bot'], async (ctx, m) => publishBatchNow(m[1], ctx)],
  ['GET', /^\/v1\/batches\/(LOTE-[A-Z0-9-]+)\/results$/, ['bot', 'approver'], async (ctx, m) => buildResults(m[1], ctx)],
  ['POST', /^\/v1\/dispatch$/, ['bot'], async (ctx, m, body) => dispatch({ batchId: body?.batch_id, trigger: 'manual-dispatch' }, ctx)],
  ['GET', /^\/v1\/audit$/, ['bot'], async (ctx, m, b, url) => ({ audit: await ctx.repo.listAudit(url.searchParams.get('batch_id')) })],
  ['GET', /^\/v1\/egress$/, ['bot'], async (ctx) => ({ mode: ctx.registry.config.mode, allowed_hosts: [], ...(await ctx.repo.listEgress()) })],
  ['GET', /^\/v1\/encargos$/, ['bot'], async (ctx, m, body, url) => listQueued(ctx.repo, url.searchParams.get('status'))],
  ['POST', /^\/v1\/encargos\/([0-9a-f-]{36})\/claim$/, ['bot'], async (ctx, m) => claimEncargo(ctx.repo, { encargoId: m[1], now: ctx.now(), actor: ctx.actor })],
  ['POST', /^\/v1\/encargos\/([0-9a-f-]{36})\/result$/, ['bot'], async (ctx, m, body) => submitEncargoResult(ctx.repo, {
    encargoId: m[1], body, now: ctx.now(), r2: ctx.r2, actor: ctx.actor,
  })],
];

export default {
  async fetch(request, env, execCtx) {
    const url = new URL(request.url);
    if (isMcpRoute(url.pathname)) {
      try {
        return await handleMcp(request, env, execCtx);
      } catch (e) {
        if (e instanceof DomainError) return json(e.http, { ok: false, error: e.toJSON() });
        console.error('UNHANDLED', e?.stack ?? e);
        return json(500, { ok: false, error: { code: 'INTERNAL', message: 'Error interno (ver logs del Worker)' } });
      }
    }
    const repo = new D1Repository(env.DB);
    try {
      const certHost = teamDomainHostname(env);
      if (certHost) allowEgressHost(certHost);
      const accessPayload = await verifyAccessJwt(request, env, accessJwtDeps);

      if (request.method === 'GET' && url.pathname === '/v1/health') {
        await applyHttpRateLimit(request, env, { scope: 'health' });
        let mode;
        try { mode = createPublisherRegistry(env, {}).config; } catch (e) { mode = { error: e.code ?? 'CONFIG', message: e.message }; }
        return json(200, { ok: true, service: 'influ-poc-orchestrator', version: SERVICE_VERSION, publisher: mode, live_enabled_in_build: LIVE_ENABLED_IN_BUILD, notice: 'POC Fase 1 — publicación SIMULADA' });
      }
      if (isPersonRoute(url.pathname)) {
        const email = normalizeEmail(accessPayload?.email);
        if (!email) throw err('ACCESS_DENIED', 'Esta ruta es solo para una persona', 403);
        await applyHttpRateLimit(request, env, { scope: 'user', bucketKey: `user:${email}` });
        const now = new Date().toISOString();
        const personCtx = buildCtx(env, { actor: `access:${email}`, keyId: 'access' });
        const partMatch = /^\/v1\/me\/uploads\/([^/]+)\/parts\/([^/]+)$/.exec(url.pathname);
        if (partMatch && request.method === 'PUT') {
          const data = await putUploadPart(personCtx, { email, uploadId: partMatch[1], part: partMatch[2], request, now });
          return json(200, { ok: true, data });
        }
        const mediaMatch = /^\/v1\/me\/media\/([^/]+)$/.exec(url.pathname);
        if (mediaMatch && request.method === 'GET') {
          return await getMediaResponse(personCtx, { email, sha256: mediaMatch[1], now, request });
        }
        const encargoMatch = /^\/v1\/me\/encargos\/([^/]+)$/.exec(url.pathname);
        if (encargoMatch && request.method === 'GET') {
          return await getEncargoHttpResponse(personCtx.repo, { email, encargoId: encargoMatch[1], request });
        }
        const personBytes = new Uint8Array(await request.arrayBuffer());
        if (personBytes.length > PERSON_BODY_MAX) throw err('INVALID_INPUT', 'Cuerpo demasiado grande', 400);
        let personBody = null;
        if (personBytes.length) {
          try { personBody = JSON.parse(new TextDecoder().decode(personBytes)); } catch { throw err('INVALID_JSON', 'Cuerpo JSON inválido', 400); }
        }
        const data = await dispatchPerson(personCtx.repo, {
          method: request.method, pathname: url.pathname, body: personBody, email, now, r2: personCtx.r2,
          dispatchBatch: (batchId) => dispatch({ batchId, trigger: 'schedule-now' }, personCtx),
        });
        const status = data?.__http ?? 200;
        if (data && typeof data === 'object') delete data.__http;
        if (status < 400) await maybeNotifyEncargo(env, execCtx, request.method, data);
        return json(status, { ok: true, data });
      }
      if (!isAuthenticatedAttempt(request)) {
        await applyHttpRateLimit(request, env, { scope: 'anon' });
      }
      const bodyBytes = new Uint8Array(await request.arrayBuffer());
      // Subida de multimedia: PUT /v1/media/<sha256>
      const mm = /^\/v1\/media\/([a-f0-9]{64})$/.exec(url.pathname);
      if (mm && request.method === 'PUT') {
        const settings = runtimeSettings(env);
        const keyId = await verifyRequest(request, bodyBytes, env, { windowSeconds: settings.signatureWindowSeconds, allowedKeys: ['bot'], useNonce: (n, k) => repo.useNonce(n, k, new Date().toISOString()) });
        if (bodyBytes.length === 0 || bodyBytes.length > MAX_MEDIA_BYTES) throw err('MEDIA_INVALID', `Tamaño no permitido (máx. ${MAX_MEDIA_BYTES} bytes)`, 400);
        const mime = request.headers.get('content-type') ?? '';
        if (!/^(video|image)\/[a-z0-9.+-]+$/.test(mime)) throw err('MEDIA_INVALID', `Tipo de archivo no admitido: ${mime}`, 400);
        const filename = (request.headers.get('x-media-filename') ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
        if (!filename) throw err('MEDIA_INVALID', 'Falta X-Media-Filename', 400);
        const real = await sha256Hex(bodyBytes);
        if (real !== mm[1]) throw err('MEDIA_INVALID', 'El sha256 del contenido no coincide con la URL', 400);
        const media = new KvMediaStorage(env.MEDIA, env.DB);
        const existing = await media.head(real);
        const r = existing ? { key: `media/${real}`, size_bytes: existing.size_bytes, sha256: real, already_stored: true } : await media.put(real, bodyBytes, { mime, filename });
        await repo.audit(keyId, 'MEDIA_STORED', null, { sha256: real, size: bodyBytes.length, mime, filename });
        return json(200, { ok: true, data: r });
      }
      const route = ROUTES.find(([method, re]) => method === request.method && re.test(url.pathname));
      if (!route) throw err('NOT_FOUND', 'Ruta no encontrada', 404);
      const [, re, allowedKeys, handler] = route;
      const settings = runtimeSettings(env);
      const keyId = await verifyRequest(request, bodyBytes, env, { windowSeconds: settings.signatureWindowSeconds, allowedKeys, useNonce: (n, k) => repo.useNonce(n, k, new Date().toISOString()) });
      let body = null;
      if (bodyBytes.length) {
        try { body = JSON.parse(new TextDecoder().decode(bodyBytes)); } catch { throw err('INVALID_JSON', 'Cuerpo JSON inválido', 400); }
      }
      const ctx = buildCtx(env, { actor: keyId === 'approver' ? 'approver' : 'grok-bot', keyId });
      const data = await handler(ctx, re.exec(url.pathname), body, url);
      await flushEgress(repo, `${request.method} ${url.pathname}`);
      return json(200, { ok: true, data });
    } catch (e) {
      await flushEgress(repo, `${request.method} ${url.pathname}`).catch(() => {});
      if (e instanceof DomainError) return json(e.http, { ok: false, error: e.toJSON() });
      console.error('UNHANDLED', e?.stack ?? e);
      return json(500, { ok: false, error: { code: 'INTERNAL', message: 'Error interno (ver logs del Worker)' } });
    }
  },

  // WF-03: ejecución periódica (Cron Trigger). Nunca aprueba nada: solo despacha lo ya aprobado.
  async scheduled(event, env, execCtx) {
    const ctx = buildCtx(env, { actor: 'cron', keyId: 'cron' });
    execCtx.waitUntil((async () => {
      try {
        await dispatch({ trigger: `cron:${event.cron}` }, ctx);
        await retryPendingDeletes(ctx);
        await deleteOrphanUploads(ctx);
        const nowSec = Math.floor(Date.now() / 1000);
        await purgeOldRateWindows(env.DB, Math.floor(nowSec / 60) - 120);
        await ctx.repo.purgeNonces(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
      } catch (e) {
        await ctx.repo.audit('cron', 'DISPATCH_ERROR', null, { code: e.code ?? 'INTERNAL', message: e.message });
      } finally {
        try {
          await releaseExpiredReservations(ctx);
        } catch {
          console.info(JSON.stringify({ event: 'reservation_release_error' }));
        }
        try {
          const nowIso = new Date(event.scheduledTime ?? Date.now()).toISOString();
          await reviewUnclaimedQueue(ctx.repo, nowIso);
        } catch {
          console.info(JSON.stringify({ event: 'encargo_backup_review_error' }));
        }
        await flushEgress(ctx.repo, 'cron');
      }
    })());
  },
};
