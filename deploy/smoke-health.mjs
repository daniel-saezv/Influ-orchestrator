#!/usr/bin/env node
/**
 * Smoke post-deploy: Access bloquea sin token; con service token /v1/health => 200 y live=false.
 *
 * Env: INFLU_BASE_URL (o WORKER_NAME + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN),
 *      INFLU_CF_ACCESS_CLIENT_ID, INFLU_CF_ACCESS_CLIENT_SECRET
 */
const workerName = process.env.WORKER_NAME ?? 'influ-poc-orchestrator';

async function resolveBaseUrl() {
  const explicit = process.env.INFLU_BASE_URL?.replace(/\/$/, '');
  if (explicit) return explicit;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    throw new Error('Define INFLU_BASE_URL o CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN');
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(`No se pudo resolver workers.dev: ${JSON.stringify(body.errors ?? body)}`);
  }
  return `https://${workerName}.${body.result.subdomain}.workers.dev`;
}

async function main() {
  const base = await resolveBaseUrl();
  const healthUrl = `${base}/v1/health`;

  const anon = await fetch(healthUrl, { redirect: 'manual' });
  const anonStatus = anon.status;
  if (![302, 403, 401].includes(anonStatus)) {
    console.error(`::error::Sin token: se esperaba 302/403/401 (Access), recibido ${anonStatus}`);
    process.exit(1);
  }
  console.log(`OK sin token: HTTP ${anonStatus} (Access activo)`);

  const clientId = process.env.INFLU_CF_ACCESS_CLIENT_ID?.trim();
  const clientSecret = process.env.INFLU_CF_ACCESS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Faltan INFLU_CF_ACCESS_CLIENT_ID / INFLU_CF_ACCESS_CLIENT_SECRET para smoke con token');
  }

  const authed = await fetch(healthUrl, {
    headers: {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
    },
  });
  const text = await authed.text();
  if (authed.status !== 200) {
    console.error(`::error::Con service token: se esperaba 200, recibido ${authed.status}: ${text.slice(0, 200)}`);
    process.exit(1);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error('::error::Respuesta /v1/health no es JSON');
    process.exit(1);
  }
  if (json.live_enabled_in_build !== false) {
    console.error(`::error::live_enabled_in_build debe ser false (recibido ${json.live_enabled_in_build})`);
    process.exit(1);
  }
  console.log('OK con service token: 200, live_enabled_in_build=false');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});