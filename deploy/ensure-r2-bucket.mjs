#!/usr/bin/env node
/**
 * Crea influ-poc-media o influ-poc-media-preview si no existe.
 * No borra buckets y no aplica ciclo de vida: los huérfanos los borra el cron.
 *
 * Uso: node deploy/ensure-r2-bucket.mjs production|preview
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRODUCTION_BUCKET = 'influ-poc-media';
export const PREVIEW_BUCKET = 'influ-poc-media-preview';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function assertWranglerR2(text) {
  const production = text.match(/\[\[r2_buckets\]\]\r?\nbinding = "MEDIA_R2"\r?\nbucket_name = "([^"]+)"/);
  const preview = text.match(/\[\[previews\.r2_buckets\]\]\r?\nbinding = "MEDIA_R2"\r?\nbucket_name = "([^"]+)"/);
  if (production?.[1] !== PRODUCTION_BUCKET) {
    throw new Error(`El binding de producción debe ser ${PRODUCTION_BUCKET}`);
  }
  if (preview?.[1] === PRODUCTION_BUCKET) {
    throw new Error('La preview apunta al bucket de producción');
  }
  if (preview?.[1] !== PREVIEW_BUCKET) {
    throw new Error(`El binding de preview debe ser ${PREVIEW_BUCKET}`);
  }
  const previewAt = text.indexOf('[previews.vars]');
  if (previewAt < 0) throw new Error('Falta [previews.vars]');
  const names = [...text.slice(previewAt).matchAll(/^bucket_name = "([^"]+)"/gm)].map((match) => match[1]);
  if (names.includes(PRODUCTION_BUCKET)) {
    throw new Error('La preview apunta al bucket de producción');
  }
  if (!names.includes(PREVIEW_BUCKET)) {
    throw new Error('Falta el bucket de preview');
  }
}

function bucketName(which) {
  if (which === 'production') return PRODUCTION_BUCKET;
  if (which === 'preview') return PREVIEW_BUCKET;
  throw new Error('Uso: node deploy/ensure-r2-bucket.mjs production|preview');
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
    const detail = JSON.stringify(body.errors ?? body.messages ?? body);
    throw new Error(`Cloudflare ${path} HTTP ${response.status}: ${detail}`);
  }
  return body;
}

async function findBucket(accountId, token, name) {
  let cursor = '';
  for (let page = 0; page < 20; page += 1) {
    const query = cursor ? `?per_page=100&cursor=${encodeURIComponent(cursor)}` : '?per_page=100';
    const body = await cf(accountId, token, `/accounts/${accountId}/r2/buckets${query}`);
    const buckets = body.result?.buckets ?? [];
    const hit = buckets.find((bucket) => bucket.name === name);
    if (hit) return hit;
    cursor = body.result_info?.cursor ?? '';
    if (!cursor || buckets.length === 0) return null;
  }
  return null;
}

export async function ensureBucket(accountId, token, name) {
  if (name !== PRODUCTION_BUCKET && name !== PREVIEW_BUCKET) {
    throw new Error(`Nombre de bucket no admitido: ${name}`);
  }
  let row = await findBucket(accountId, token, name);
  if (!row) {
    try {
      await cf(accountId, token, `/accounts/${accountId}/r2/buckets`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    } catch (error) {
      row = await findBucket(accountId, token, name);
      if (!row) throw error;
    }
    row = row ?? await findBucket(accountId, token, name);
  }
  if (!row || row.name !== name) {
    throw new Error(`La API no confirmó el bucket ${name}`);
  }
  return row.name;
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    throw new Error('Faltan CLOUDFLARE_API_TOKEN o CLOUDFLARE_ACCOUNT_ID');
  }
  const name = bucketName(process.argv[2]);
  assertWranglerR2(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8'));
  const created = await ensureBucket(accountId, token, name);
  console.log(`Bucket R2 listo: ${created}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch(() => {
    console.error('::error::No se pudo preparar el bucket R2');
    process.exit(1);
  });
}
