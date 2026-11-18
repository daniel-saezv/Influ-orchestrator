#!/usr/bin/env node
/**
 * Crea influ-poc-db-preview si no existe y escribe su uuid en los bindings de preview.
 * No crea, borra ni migra influ-poc-db.
 *
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PREVIEW_D1_NAME = 'influ-poc-db-preview';
export const PRODUCTION_D1_NAME = 'influ-poc-db';
export const PRODUCTION_D1_ID = 'ef8d5216-77f4-4921-84d3-acc5e24820aa';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_TOML = join(ROOT, 'wrangler.toml');
const MIGRATIONS_TOML = join(ROOT, 'wrangler.preview-d1.toml');

const BINDING_RE = /database_name = "influ-poc-db-preview"\r?\ndatabase_id = "[^"]+"/;

export function patchPreviewDatabaseId(text, databaseId) {
  if (databaseId === PRODUCTION_D1_ID) {
    throw new Error('Rechazado: el id de la D1 de preview es el de producción');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
    throw new Error('El id de la D1 de preview no es un uuid');
  }
  if (!BINDING_RE.test(text)) {
    throw new Error(`No está el binding ${PREVIEW_D1_NAME}`);
  }
  const next = text.replace(
    BINDING_RE,
    `database_name = "${PREVIEW_D1_NAME}"\ndatabase_id = "${databaseId}"`,
  );
  const productionBefore = text.match(/database_name = "influ-poc-db"\r?\ndatabase_id = "([^"]+)"/);
  const productionAfter = next.match(/database_name = "influ-poc-db"\r?\ndatabase_id = "([^"]+)"/);
  if ((productionBefore?.[1] ?? null) !== (productionAfter?.[1] ?? null)) {
    throw new Error('El binding de influ-poc-db ha cambiado');
  }
  return next;
}

export function assertMigrationsConfig(text) {
  const names = [...text.matchAll(/^database_name = "([^"]+)"/gm)].map((match) => match[1]);
  if (names.length !== 1 || names[0] !== PREVIEW_D1_NAME) {
    throw new Error(`${MIGRATIONS_TOML} debe declarar solo ${PREVIEW_D1_NAME}`);
  }
  if (text.includes(PRODUCTION_D1_ID) || text.includes(`"${PRODUCTION_D1_NAME}"`)) {
    throw new Error('La config de migraciones de preview apunta a producción');
  }
}

function databaseId(row) {
  const id = row?.uuid ?? row?.id;
  if (typeof id !== 'string' || !id) throw new Error('La API de D1 no devolvió uuid');
  return id;
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

async function findDatabase(accountId, token, name) {
  const filtered = await cf(
    accountId,
    token,
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=20`,
  );
  const exact = (filtered.result ?? []).find((row) => row.name === name);
  if (exact) return exact;

  let page = 1;
  for (;;) {
    const body = await cf(
      accountId,
      token,
      `/accounts/${accountId}/d1/database?page=${page}&per_page=100`,
    );
    const rows = body.result ?? [];
    const hit = rows.find((row) => row.name === name);
    if (hit) return hit;
    const total = body.result_info?.total_pages ?? 1;
    if (page >= total || rows.length === 0) return null;
    page += 1;
  }
}

export async function ensurePreviewDatabase(accountId, token) {
  let row = await findDatabase(accountId, token, PREVIEW_D1_NAME);
  if (!row) {
    try {
      const created = await cf(accountId, token, `/accounts/${accountId}/d1/database`, {
        method: 'POST',
        body: JSON.stringify({ name: PREVIEW_D1_NAME }),
      });
      row = created.result;
    } catch (error) {
      row = await findDatabase(accountId, token, PREVIEW_D1_NAME);
      if (!row) throw error;
    }
  }
  if (row.name !== PREVIEW_D1_NAME) {
    throw new Error(`La API devolvió ${row.name}, no ${PREVIEW_D1_NAME}`);
  }
  const id = databaseId(row);
  if (id === PRODUCTION_D1_ID) {
    throw new Error('Rechazado: influ-poc-db-preview tiene el id de influ-poc-db');
  }
  return id;
}

function writePatched(path, databaseIdValue) {
  const next = patchPreviewDatabaseId(readFileSync(path, 'utf8'), databaseIdValue);
  writeFileSync(path, next);
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    throw new Error('Faltan CLOUDFLARE_API_TOKEN o CLOUDFLARE_ACCOUNT_ID');
  }
  const id = await ensurePreviewDatabase(accountId, token);
  writePatched(WRANGLER_TOML, id);
  writePatched(MIGRATIONS_TOML, id);
  assertMigrationsConfig(readFileSync(MIGRATIONS_TOML, 'utf8'));
  const production = readFileSync(WRANGLER_TOML, 'utf8')
    .match(/database_name = "influ-poc-db"\r?\ndatabase_id = "([^"]+)"/);
  if (production?.[1] !== PRODUCTION_D1_ID) {
    throw new Error('wrangler.toml ya no apunta la D1 de producción al id esperado');
  }
  console.log(`D1 de preview lista: ${PREVIEW_D1_NAME} ${id}`);
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
