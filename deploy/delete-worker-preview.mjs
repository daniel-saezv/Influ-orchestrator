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

export function findPreviewByName(previews, previewName) {
  if (!Array.isArray(previews)) return undefined;
  return previews.find((row) => row?.name === previewName || row?.slug === previewName);
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
  const detail = JSON.stringify(body?.errors ?? body?.messages ?? body);
  return new Error(`Cloudflare ${path} HTTP ${status}: ${detail}`);
}

export async function deleteWorkerPreviewByName({
  accountId,
  token,
  workerName,
  previewName,
  fetchFn = fetch,
}) {
  const listPath = `/accounts/${accountId}/workers/workers/${encodeURIComponent(workerName)}/previews`;
  const listed = await cloudflareRequest(fetchFn, token, listPath, { method: 'GET' });
  if (!listed.body?.success) {
    if (isPreviewNotFound(listed.response.status, listed.body?.errors)) {
      return { status: 'absent' };
    }
    throw formatApiFailure(listPath, listed.response.status, listed.body);
  }
  const match = findPreviewByName(listed.body.result, previewName);
  if (!match?.id) {
    return { status: 'absent' };
  }
  const deletePath = `${listPath}/${encodeURIComponent(match.id)}`;
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
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}