#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function workerNameFromWranglerToml(text) {
  const match = text.match(/^name\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('Falta name en wrangler.toml');
  return match[1];
}

export function isPreviewNotFound(status, errors) {
  if (status === 404) return true;
  if (!Array.isArray(errors)) return false;
  return errors.some((entry) => entry?.code === 10025 || entry?.code === 10222);
}

export function previewRowsFromResult(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.previews)) return result.previews;
  return [];
}

export function findPreviewByName(previews, previewName) {
  const rows = Array.isArray(previews) ? previews : previewRowsFromResult(previews);
  return rows.find((row) => row?.name === previewName || row?.slug === previewName);
}

export function cloudflareErrorCodes(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((entry) => entry?.code).filter((code) => code !== undefined && code !== null);
}

async function cloudflareRequest(fetchFn, token, path, init = {}) {
  const response = await fetchFn(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function formatApiFailure(path, status, body) {
  const error = new Error('cloudflare_api_error');
  error.httpStatus = status;
  error.apiPath = path;
  error.codes = cloudflareErrorCodes(body?.errors);
  return error;
}

async function previewByName(fetchFn, token, previewsPath, previewName) {
  const path = `${previewsPath}/${encodeURIComponent(previewName)}`;
  const got = await cloudflareRequest(fetchFn, token, path, { method: 'GET' });
  if (got.body?.success && got.body.result?.id) {
    return got.body.result;
  }
  if (isPreviewNotFound(got.response.status, got.body?.errors)) {
    return null;
  }
  throw formatApiFailure(path, got.response.status, got.body);
}

async function resolvePreview(fetchFn, token, previewsPath, previewName) {
  const direct = await previewByName(fetchFn, token, previewsPath, previewName);
  if (direct?.id) return direct;
  const listed = await cloudflareRequest(fetchFn, token, previewsPath, { method: 'GET' });
  if (!listed.body?.success) {
    if (isPreviewNotFound(listed.response.status, listed.body?.errors)) {
      return null;
    }
    throw formatApiFailure(previewsPath, listed.response.status, listed.body);
  }
  return findPreviewByName(listed.body.result, previewName) ?? null;
}

export async function deleteWorkerPreviewByName({
  accountId,
  token,
  workerName,
  previewName,
  fetchFn = fetch,
}) {
  const previewsPath = `/accounts/${accountId}/workers/workers/${encodeURIComponent(workerName)}/previews`;
  const match = await resolvePreview(fetchFn, token, previewsPath, previewName);
  if (!match?.id) {
    return { status: 'absent' };
  }
  const deletePath = `${previewsPath}/${encodeURIComponent(match.id)}`;
  const deleted = await cloudflareRequest(fetchFn, token, deletePath, { method: 'DELETE' });
  if (deleted.body?.success !== false && (deleted.response.ok || deleted.body?.success)) {
    return { status: 'deleted', previewId: match.id };
  }
  if (isPreviewNotFound(deleted.response.status, deleted.body?.errors)) {
    return { status: 'absent' };
  }
  throw formatApiFailure(deletePath, deleted.response.status, deleted.body);
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const previewName = process.env.PREVIEW_NAME?.trim();
  if (!token || !accountId || !previewName) {
    throw new Error('Faltan CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID o PREVIEW_NAME');
  }
  const workerName = workerNameFromWranglerToml(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8'));
  const outcome = await deleteWorkerPreviewByName({
    accountId,
    token,
    workerName,
    previewName,
  });
  if (outcome.status === 'absent') {
    console.log(`Preview ${previewName} no encontrada en ${workerName}`);
    return;
  }
  console.log(`Preview ${previewName} borrada (${outcome.previewId})`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    if (Array.isArray(error.codes) && error.codes.length > 0) {
      console.error(`::error::No se pudo borrar la preview del Worker (códigos Cloudflare: ${error.codes.join(', ')})`);
    } else {
      console.error('::error::No se pudo borrar la preview del Worker');
    }
    process.exit(1);
  });
}