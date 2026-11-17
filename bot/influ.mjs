#!/usr/bin/env node
// CLI de Grok Bot para operar la POC (lo que usa el bot cuando el usuario pide/aprueba lotes).
// Lee los secretos de las variables de entorno INFLU_BOT_HMAC_SECRET / INFLU_APPROVER_HMAC_SECRET (secretos del bot).
//
//   node bot/influ.mjs health
//   node bot/influ.mjs submit  content/batches/LOTE-0001          (sube media + envía el lote)
//   node bot/influ.mjs update  content/batches/LOTE-0001 "nota"   (nueva versión => invalida aprobación)
//   node bot/influ.mjs review  LOTE-0001                          (presentación para revisión)
//   node bot/influ.mjs status  LOTE-0001
//   node bot/influ.mjs decide  "APROBAR LOTE-0001" --version 1 --hash <huella> --by "Gamusino"
//   node bot/influ.mjs decide  "CAMBIOS LOTE-0001: texto" --version 1 --hash <huella> --by "Gamusino"
//   node bot/influ.mjs publish LOTE-0001                          (intento explícito; bloqueado sin aprobación)
//   node bot/influ.mjs dispatch [LOTE-0001]                       (ejecuta WF-03 a demanda)
//   node bot/influ.mjs results LOTE-0001                          (informe de resultados)
//   node bot/influ.mjs list | audit [LOTE-0001] | egress
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { OrchestratorClient, materializeBatch } from './client-lib.mjs';

const cfg = loadInfluConfig();
const c = new OrchestratorClient({ baseUrl: cfg.base_url, botSecret: cfg.bot_secret, approverSecret: cfg.approver_secret });
const [cmd, a1, a2] = process.argv.slice(2);
const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const show = (r) => { console.log(JSON.stringify(r, null, 2)); process.exitCode = r.ok === false ? 1 : 0; };

function probe(path) {
  try {
    const o = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path]).toString());
    return { duration_s: Math.round(Number(o.format.duration) * 10) / 10, width: o.streams[0].width, height: o.streams[0].height };
  } catch { return {}; }
}

async function load(dir) {
  const d = resolve(dir);
  const def = JSON.parse(readFileSync(join(d, 'batch.json'), 'utf8'));
  const m = await materializeBatch(def, d, { probe });
  for (const f of m.files) {
    const r = await c.uploadMedia(f.sha256, f.bytes, f.mime, f.filename);
    if (!r.ok) { show(r); process.exit(1); }
    console.error(`media ${f.filename} -> ${r.data.key}${r.data.already_stored ? ' (ya existía)' : ''}`);
  }
  return m.batch;
}

switch (cmd) {
  case 'health': show(await c.health()); break;
  case 'submit': show(await c.submitBatch(await load(a1))); break;
  case 'update': show(await c.updateBatch(await load(a1), a2 ?? 'Cambios solicitados')); break;
  case 'review': { const r = await c.getReview(a1); if (r.ok) console.log(r.data.review_markdown); else show(r); break; }
  case 'status': show(await c.getBatchStatus(a1)); break;
  case 'decide': {
    const id = /(LOTE-[A-Z0-9-]+)/.exec(a1 ?? '')?.[1];
    if (!id || !opt('version') || !opt('hash') || !opt('by')) { console.error('Uso: decide "APROBAR LOTE-XXXX" --version N --hash HUELLA --by NOMBRE'); process.exit(2); }
    show(await c.decide(id, { commandText: a1, version: Number(opt('version')), contentHash: opt('hash'), decidedBy: opt('by') }));
    break;
  }
  case 'publish': show(await c.publishBatch(a1)); break;
  case 'dispatch': show(await c.dispatch(a1)); break;
  case 'results': { const r = await c.getPublicationResults(a1); if (r.ok && !process.argv.includes('--json')) console.log(r.data.report_markdown); else show(r); break; }
  case 'list': show(await c.call('GET', '/v1/batches')); break;
  case 'audit': show(await c.audit(a1)); break;
  case 'egress': show(await c.egress()); break;
  default: console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).join('\n'));
}

// Secretos: variables de entorno (secretos del bot de Grok Bot). El archivo local solo queda como respaldo temporal.
function loadInfluConfig() {
  const p = join(homedir(), '.config/influ-poc/secrets.json');
  let file = {};
  try { file = JSON.parse(readFileSync(p, 'utf8')); } catch {}
  return {
    base_url: process.env.INFLU_BASE_URL ?? file.base_url ?? 'https://influ-poc-orchestrator.gamu-development.workers.dev',
    bot_secret: process.env.INFLU_BOT_HMAC_SECRET ?? file.bot_secret,
    approver_secret: process.env.INFLU_APPROVER_HMAC_SECRET ?? file.approver_secret,
  };
}
