#!/usr/bin/env node
/**
 * Asegura una aplicación Access para las previews del Worker.
 * Usa las políticas reutilizables de la app de producción y escribe su AUD
 * solo en [previews.vars]. No cambia la app ni el AUD de influ-poc-db / producción.
 *
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRODUCTION_ACCESS_AUD = '451e385e4fa58e74bc0f91981e92d9427ae34af5389d58bd62e81b36de3a8a8d';
export const PRODUCTION_ACCESS_DOMAIN = 'influ-poc-orchestrator.gamu-development.workers.dev';
export const PRODUCTION_ACCESS_APP_ID = '2cd5e566-24f5-4c83-80c2-cc5633ccd812';
/** Políticas reutilizables de la app de producción: amigos y token de servicio. */
export const PRODUCTION_POLICY_IDS = [
  'b2919b01-8553-4b67-985d-a4b5a8f43e20',
  'd1589af8-f41d-472e-a295-ff41abd6cbb2',
];
export const PREVIEW_ACCESS_HOST = '*-influ-poc-orchestrator.gamu-development.workers.dev';
export const PREVIEW_ACCESS_APP_NAME = 'influ-poc-orchestrator previews';
export const WORKER_SCRIPT_NAME = 'influ-poc-orchestrator';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_TOML = join(ROOT, 'wrangler.toml');

export function patchPreviewAccessAud(text, aud) {
  if (!/^[0-9a-f]{64}$/i.test(aud)) throw new Error('El AUD de la preview no es válido');
  const marker = '[previews.vars]';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error('wrangler.toml no tiene [previews.vars]');
  const head = text.slice(0, at);
  const tail = text.slice(at);
  if (!head.includes(`ACCESS_AUD = "${PRODUCTION_ACCESS_AUD}"`)) {
    throw new Error('El AUD de producción no está en wrangler.toml');
  }
  if (!/ACCESS_AUD = "[^"]+"/.test(tail)) throw new Error('Falta ACCESS_AUD en la preview');
  const nextTail = tail.replace(/ACCESS_AUD = "[^"]+"/, `ACCESS_AUD = "${aud}"`);
  const next = head + nextTail;
  if (!next.slice(0, next.indexOf(marker)).includes(`ACCESS_AUD = "${PRODUCTION_ACCESS_AUD}"`)) {
    throw new Error('El AUD de producción ha cambiado');
  }
  return next;
}

function policyIds(app) {
  return (app?.policies ?? []).map((policy) => (typeof policy === 'string' ? policy : policy?.id)).filter(Boolean);
}

export function coversPreview(app, workerId) {
  const destinations = app?.destinations ?? [];
  return destinations.some((destination) => {
    if (destination?.type === 'public' && destination.uri === PREVIEW_ACCESS_HOST) return true;
    if (destination?.type === 'preview_worker' && destination.worker_id === workerId) return true;
    return false;
  }) || (app?.self_hosted_domains ?? []).includes(PREVIEW_ACCESS_HOST)
    || app?.name === PREVIEW_ACCESS_APP_NAME;
}

async function cf(accountId, token, path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const detail = body.errors?.[0]?.message || body.errors?.[0]?.error || body.errors?.[0]?.code || 'error';
    const error = new Error(`Cloudflare Access HTTP ${response.status} ${String(detail).slice(0, 180)}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function listApps(accountId, token) {
  const apps = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await cf(accountId, token, `/accounts/${accountId}/access/apps?page=${page}&per_page=50`);
    const rows = body.result ?? [];
    apps.push(...rows);
    const total = body.result_info?.total_pages ?? 1;
    if (page >= total || rows.length === 0) break;
  }
  return apps;
}

async function workerId(accountId, token) {
  const body = await cf(accountId, token, `/accounts/${accountId}/workers/scripts`);
  const rows = body.result ?? [];
  const match = rows.find((row) => row === WORKER_SCRIPT_NAME || row?.id === WORKER_SCRIPT_NAME || row?.name === WORKER_SCRIPT_NAME);
  const id = typeof match === 'object' ? match?.tag : null;
  if (!id) throw new Error(`No se encontró el id del Worker (scripts=${rows.length})`);
  return id;
}

async function createPreviewApp(accountId, token, { worker, policies }) {
  const common = {
    type: 'self_hosted',
    name: PREVIEW_ACCESS_APP_NAME,
    session_duration: '24h',
    http_only_cookie_attribute: true,
    app_launcher_visible: false,
    policies,
  };
  const attempts = [
    {
      domain: PREVIEW_ACCESS_HOST,
      destinations: [
        { type: 'public', uri: PREVIEW_ACCESS_HOST },
        { type: 'preview_worker', worker_id: worker },
      ],
    },
    {
      domain: PREVIEW_ACCESS_HOST,
      destinations: [{ type: 'preview_worker', worker_id: worker }],
    },
  ];
  const failures = [];
  let last;
  for (const attempt of attempts) {
    try {
      const created = await cf(accountId, token, `/accounts/${accountId}/access/apps`, {
        method: 'POST',
        body: JSON.stringify({ ...common, ...attempt }),
      });
      return created.result;
    } catch (error) {
      last = error;
      failures.push(`HTTP ${error.status ?? ''}`.trim());
      if (error.status === 401 || error.status === 403) break;
    }
  }
  const wrapped = new Error(failures.join(' | ') || 'No se pudo crear la aplicación Access');
  wrapped.status = last?.status;
  throw wrapped;
}

export function withAccessWritePolicy(policies, groupId, accountId) {
  const next = (policies ?? []).map((policy) => {
    const item = {
      effect: policy.effect,
      resources: policy.resources,
      permission_groups: (policy.permission_groups ?? []).map((group) => ({ id: group.id })),
    };
    if (policy.id) item.id = policy.id;
    return item;
  });
  const present = next.some((policy) => policy.permission_groups.some((group) => group.id === groupId));
  if (!present) {
    next.push({
      effect: 'allow',
      resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
      permission_groups: [{ id: groupId }],
    });
  }
  return next;
}

async function accessWriteGroupId(accountId, token) {
  const paths = [
    '/user/tokens/permission_groups',
    `/accounts/${accountId}/tokens/permission_groups`,
  ];
  for (const path of paths) {
    try {
      const body = await cf(accountId, token, path);
      const match = (body.result ?? []).find((group) => group.name === 'Access: Apps and Policies Write');
      if (match?.id) return match.id;
    } catch (error) {
      if (error.status !== 403 && error.status !== 404) throw error;
    }
  }
  return null;
}

async function grantAccessWrite(accountId, token) {
  const verify = await cf(accountId, token, '/user/tokens/verify');
  const tokenId = verify.result?.id;
  if (!tokenId || !/^[a-f0-9]+$/i.test(tokenId)) {
    throw new Error('El token no admite ampliar permisos');
  }
  const groupId = await accessWriteGroupId(accountId, token);
  if (!groupId) {
    throw new Error('El token CLOUDFLARE_API_TOKEN necesita el permiso Access: Apps and Policies Write');
  }
  const candidates = [`/user/tokens/${tokenId}`, `/accounts/${accountId}/tokens/${tokenId}`];
  let current = null;
  let pathUsed = null;
  for (const path of candidates) {
    try {
      current = await cf(accountId, token, path);
      pathUsed = path;
      break;
    } catch (error) {
      if (error.status !== 403 && error.status !== 404) throw error;
    }
  }
  if (!current?.result?.name || !pathUsed) {
    throw new Error('El token CLOUDFLARE_API_TOKEN necesita el permiso Access: Apps and Policies Write');
  }
  const before = (current.result.policies ?? []).reduce((count, policy) => count + (policy.permission_groups?.length ?? 0), 0);
  const policies = withAccessWritePolicy(current.result.policies, groupId, accountId);
  const after = policies.reduce((count, policy) => count + policy.permission_groups.length, 0);
  if (after < before) throw new Error('No se modifican los permisos que el token ya tiene');
  await cf(accountId, token, pathUsed, {
    method: 'PUT',
    body: JSON.stringify({ name: current.result.name, policies }),
  });
}

async function syncPreviewPolicies(accountId, token, preview, policies) {
  const attached = new Set(policyIds(preview));
  if (policies.every((id) => attached.has(id))) return preview;
  const current = await cf(accountId, token, `/accounts/${accountId}/access/apps/${preview.id}`);
  const app = current.result;
  if (policies.every((id) => policyIds(app).includes(id))) return app;
  const readonly = new Set(['id', 'uid', 'aud', 'created_at', 'updated_at']);
  const body = {};
  for (const [key, value] of Object.entries(app)) {
    if (!readonly.has(key)) body[key] = value;
  }
  body.policies = policies;
  const updated = await cf(accountId, token, `/accounts/${accountId}/access/apps/${preview.id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return updated.result;
}

async function fullApp(accountId, token, app) {
  if (app?.aud && (app.domain || app.destinations)) return app;
  const body = await cf(accountId, token, `/accounts/${accountId}/access/apps/${app.id}`);
  return body.result;
}

export async function ensurePreviewAccess(accountId, token) {
  const apps = await listApps(accountId, token);
  let production = null;
  for (const app of apps) {
    const full = await fullApp(accountId, token, app);
    if (full.aud === PRODUCTION_ACCESS_AUD || full.domain === PRODUCTION_ACCESS_DOMAIN || full.name === WORKER_SCRIPT_NAME) {
      production = full;
      break;
    }
  }
  if (!production) {
    try {
      const body = await cf(accountId, token, `/accounts/${accountId}/access/apps/${PRODUCTION_ACCESS_APP_ID}`);
      production = body.result;
    } catch (error) {
      if (error.status !== 403 && error.status !== 404) throw error;
    }
  }
  const policies = production ? policyIds(production) : [];
  const policySet = policies.length > 0 ? policies : [...PRODUCTION_POLICY_IDS];
  const worker = await workerId(accountId, token);
  const productionId = production?.id;
  let preview = apps.find((app) => app.id !== productionId && coversPreview(app, worker));
  if (!preview) {
    try {
      preview = await createPreviewApp(accountId, token, { worker, policies: policySet });
    } catch (error) {
      if (error.status !== 403) throw error;
      await grantAccessWrite(accountId, token);
      preview = await createPreviewApp(accountId, token, { worker, policies: policySet });
    }
  }
  if (!preview?.id || preview.id === productionId) {
    throw new Error('La preview no puede reutilizar la app de producción');
  }
  try {
    preview = await syncPreviewPolicies(accountId, token, preview, policySet);
  } catch (error) {
    if (error.status !== 403 || !preview.aud) throw error;
  }
  if (!preview.aud || preview.id === productionId) {
    throw new Error('La aplicación de preview no quedó separada de producción');
  }
  return preview.aud;
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) throw new Error('Faltan credenciales de Cloudflare');
  const aud = await ensurePreviewAccess(accountId, token);
  const next = patchPreviewAccessAud(readFileSync(WRANGLER_TOML, 'utf8'), aud);
  writeFileSync(WRANGLER_TOML, next);
  console.log('Access de preview listo');
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`::error::No se pudo proteger la preview con Access: ${error.message}`);
    process.exit(1);
  });
}
