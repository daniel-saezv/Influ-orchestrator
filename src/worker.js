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
import { verifyRequest } from './adapters/http/auth.js';
import { installEgressGuard, drainEgressAttempts } from './adapters/http/egress-guard.js';
import { receiveBatch } from './workflows/wf01-receive-batch.js';
import { decideBatch } from './workflows/wf02-approve-batch.js';
import { dispatch, publishBatchNow } from './workflows/wf03-schedule-dispatch.js';
import { buildReview, buildResults } from './workflows/reports.js';

export const SERVICE_VERSION = '0.1.0';
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

// En MOCK la lista de hosts permitidos está vacía: ninguna salida a Internet.
installEgressGuard(() => []);

function buildCtx(env, { actor, keyId }) {
  const repo = new D1Repository(env.DB);
  const settings = runtimeSettings(env);
  return {
    repo, settings, actor, keyId,
    media: new KvMediaStorage(env.MEDIA, env.DB),
    get registry() { // perezoso: si la config de modo es inválida, solo fallan las operaciones que la usan
      if (!this._registry) this._registry = createPublisherRegistry(env, { store: new D1MockProviderStore(env.DB), maxBytes: MAX_MEDIA_BYTES });
      return this._registry;
    },
    now: () => new Date().toISOString(),
  };
}

const json = (status, body) => new Response(JSON.stringify(body, null, 2), {
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
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const repo = new D1Repository(env.DB);
    try {
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        let mode;
        try { mode = createPublisherRegistry(env, {}).config; } catch (e) { mode = { error: e.code ?? 'CONFIG', message: e.message }; }
        return json(200, { ok: true, service: 'influ-poc-orchestrator', version: SERVICE_VERSION, publisher: mode, live_enabled_in_build: LIVE_ENABLED_IN_BUILD, notice: 'POC Fase 1 — publicación SIMULADA' });
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
        await ctx.repo.purgeNonces(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
      } catch (e) {
        await ctx.repo.audit('cron', 'DISPATCH_ERROR', null, { code: e.code ?? 'INTERNAL', message: e.message });
      } finally {
        await flushEgress(ctx.repo, 'cron');
      }
    })());
  },
};
