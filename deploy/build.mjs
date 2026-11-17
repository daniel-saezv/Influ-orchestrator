// Genera los scripts que se ejecutan con la herramienta "execute" del conector MCP de Cloudflare
// (la API de Cloudflare se usa vía conector; no hay token local). Salida: deploy/out/*.js (ignorado por git).
//   node deploy/build.mjs worker    -> deploy/out/deploy-worker.js   (sube el Worker + bindings + cron + workers.dev)
//   node deploy/build.mjs migrate   -> deploy/out/migrate.js         (aplica migrations/*.sql en D1)
//   node deploy/build.mjs secrets   -> LEGACY: genera claves aleatorias locales (y opcionalmente deploy/out/secrets.js
//                                       vía MCP). Los Secrets del Worker (BOT_HMAC_SECRET / APPROVER_HMAC_SECRET)
//                                       deben configurarse manualmente en el panel de Cloudflare o con
//                                       `wrangler secret put`. El CLI del bot usa INFLU_BOT_HMAC_SECRET,
//                                       INFLU_APPROVER_HMAC_SECRET e INFLU_BASE_URL (secretos del entorno del bot).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, chmodSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'deploy/cloudflare.json'), 'utf8'));
const OUT = join(ROOT, 'deploy/out');
mkdirSync(OUT, { recursive: true });
const what = process.argv[2];

if (what === 'worker') {
  const modules = {};
  const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) modules[relative(join(ROOT, 'src'), p)] = readFileSync(p, 'utf8'); });
  walk(join(ROOT, 'src'));
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: cfg.compatibility_date,
    bindings: [
      { type: 'd1', name: cfg.d1.binding, id: cfg.d1.id },
      { type: 'kv_namespace', name: cfg.kv.binding, namespace_id: cfg.kv.id },
      ...Object.entries(cfg.vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    ],
    keep_bindings: ['secret_text'],
    observability: { enabled: true },
  };
  const code = `async () => {
  const modules = ${JSON.stringify(modules)};
  const metadata = ${JSON.stringify(metadata)};
  const name = ${JSON.stringify(cfg.worker_name)};
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  for (const [path, src] of Object.entries(modules)) form.append(path, new Blob([src], { type: 'application/javascript+module' }), path);
  const up = await cloudflare.request({ method: 'PUT', path: \`/accounts/\${accountId}/workers/scripts/\${name}\`, body: form });
  const sub = await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/workers/scripts/\${name}/subdomain\`, body: { enabled: true, previews_enabled: false } });
  const cron = await cloudflare.request({ method: 'PUT', path: \`/accounts/\${accountId}/workers/scripts/\${name}/schedules\`, body: ${JSON.stringify(cfg.crons.map((c) => ({ cron: c })))} });
  const s = await cloudflare.request({ method: 'GET', path: \`/accounts/\${accountId}/workers/subdomain\` });
  return { uploaded: up.success, etag: up.result?.etag, modules: Object.keys(modules).length, workers_dev: sub.success, crons: cron.result?.schedules, url: \`https://\${name}.\${s.result.subdomain}.workers.dev\` };
}`;
  writeFileSync(join(OUT, 'deploy-worker.js'), code);
  console.log(`deploy/out/deploy-worker.js (${Object.keys(modules).length} módulos, ${code.length} bytes)`);
} else if (what === 'migrate') {
  const sql = readdirSync(join(ROOT, 'migrations')).sort().map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf8')).join('\n');
  const code = `async () => {
  const r = await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/d1/database/${cfg.d1.id}/query\`, body: { sql: ${JSON.stringify(sql)} } });
  const t = await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/d1/database/${cfg.d1.id}/query\`, body: { sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" } });
  return { ok: r.success, statements: r.result.length, tables: t.result[0].results.map((x) => x.name) };
}`;
  writeFileSync(join(OUT, 'migrate.js'), code);
  console.log('deploy/out/migrate.js');
} else if (what === 'secrets') {
  const dir = join(homedir(), '.config/influ-poc');
  const file = join(dir, 'secrets.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const s = { base_url: existing.base_url ?? process.argv[3], bot_secret: randomBytes(32).toString('base64url'), approver_secret: randomBytes(32).toString('base64url'), rotated_at: new Date().toISOString() };
  if (!s.base_url) throw new Error('Pasa la URL base del Worker: node deploy/build.mjs secrets https://...');
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  const code = `async () => {
  const name = ${JSON.stringify(cfg.worker_name)};
  const out = [];
  for (const [n, text] of ${JSON.stringify([['BOT_HMAC_SECRET', s.bot_secret], ['APPROVER_HMAC_SECRET', s.approver_secret]])}) {
    const r = await cloudflare.request({ method: 'PUT', path: \`/accounts/\${accountId}/workers/scripts/\${name}/secrets\`, body: { name: n, text, type: 'secret_text' } });
    out.push({ name: n, ok: r.success });
  }
  return out;
}`;
  writeFileSync(join(OUT, 'secrets.js'), code, { mode: 0o600 });
  console.log(`Claves locales en ${file} (600). Script legacy: deploy/out/secrets.js — bórralo tras usarlo.`);
  console.log('Configura BOT_HMAC_SECRET y APPROVER_HMAC_SECRET en el panel de Cloudflare (o wrangler secret put); exporta INFLU_* en el entorno del bot.');
} else {
  console.log('Uso: node deploy/build.mjs worker|migrate|secrets [base_url]');
}
