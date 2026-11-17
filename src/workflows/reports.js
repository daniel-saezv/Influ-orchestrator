// Presentación para revisión y informe de resultados (texto en español, Markdown).
import { err } from '../core/domain/errors.js';
import { fmtMadrid } from './common.js';
import { summary } from './wf01-receive-batch.js';

export async function buildReview(batchId, ctx) {
  const b = await ctx.repo.getBatch(batchId);
  if (!b) throw err('BATCH_NOT_FOUND', `No existe ${batchId}`, 404);
  const pubs = await ctx.repo.listPublications(batchId, b.version);
  const val = new Map((b.validation ?? []).map((v) => [v.seq, v]));
  const L = [];
  L.push(`# ${b.batch_id} — ${b.payload.title}`);
  L.push(`Versión **${b.version}** · Estado **${b.status}** · Huella \`${b.content_hash}\``);
  L.push(`Modo de publicación: **${ctx.registry.config.mode.toUpperCase()}** (simulado, nada se publica en redes reales)`);
  L.push('');
  for (const p of pubs) {
    const c = p.post.copy; const v = val.get(p.seq);
    L.push(`## Publicación ${p.seq} · ${p.publication_id}`);
    L.push(`- Vista previa: \`${p.media_filename}\` (sha256 ${p.media_sha256.slice(0, 12)}…, ${(p.media_size / 1024).toFixed(0)} KB${p.post.media.duration_s ? `, ${p.post.media.duration_s} s` : ''}${p.post.media.width ? `, ${p.post.media.width}x${p.post.media.height}` : ''})`);
    L.push(`- Tipo de archivo: ${p.media_mime} · Tipo de contenido: ${p.content_type}`);
    L.push(`- Plataforma de destino: ${p.platform}`);
    if (c.title) L.push(`- Título: ${c.title}`);
    if (c.description) L.push(`- Descripción: ${c.description.replace(/\n/g, ' ⏎ ')}`);
    if (c.caption) L.push(`- Copy definitivo: ${c.caption}`);
    L.push(`- Hashtags: ${(c.hashtags ?? []).map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ') || '—'}`);
    if (c.tags?.length) L.push(`- Etiquetas: ${c.tags.join(', ')}`);
    L.push(`- Privacidad: ${c.privacy_status ?? '—'} · Categoría: ${c.category_id ?? '—'} · Contenido sintético: ${c.contains_synthetic_media ? 'sí' : 'no'}`);
    L.push(`- Fecha y hora previstas: ${fmtMadrid(p.scheduled_at)}`);
    L.push(`- Validación: ${v?.ok ? 'OK' : 'ERRORES'}${v?.errors?.length ? ' — ' + v.errors.map((e) => e.message).join('; ') : ''}${v?.warnings?.length ? ` (avisos: ${v.warnings.join('; ')})` : ''}`);
    L.push(`- Estado: ${p.status}`);
    L.push('');
  }
  const ok = pubs.filter((p) => val.get(p.seq)?.ok).length;
  L.push('## Resumen del lote');
  L.push(`- ${pubs.length} publicaciones · ${ok} válidas · plataformas: ${[...new Set(pubs.map((p) => p.platform))].join(', ')}`);
  L.push(`- Primera: ${fmtMadrid(pubs[0]?.scheduled_at)} · Última: ${fmtMadrid(pubs[pubs.length - 1]?.scheduled_at)}`);
  L.push(`- La aprobación cubre la versión ${b.version} con la huella indicada. Cualquier cambio posterior la invalida.`);
  L.push('');
  L.push(`Responde: \`APROBAR ${b.batch_id}\` · \`RECHAZAR ${b.batch_id}\` · \`CAMBIOS ${b.batch_id}: descripción\``);
  return { ...summary(b), review_markdown: L.join('\n'), publications: pubs.map(slimPub) };
}

export async function buildResults(batchId, ctx) {
  const b = await ctx.repo.getBatch(batchId);
  if (!b) throw err('BATCH_NOT_FOUND', `No existe ${batchId}`, 404);
  const all = await ctx.repo.listPublications(batchId);
  const pubs = all.filter((p) => p.batch_version === b.version);
  const approvals = await ctx.repo.listApprovals(batchId);
  const versions = await ctx.repo.listVersions(batchId);
  const events = await ctx.repo.listEvents(batchId);
  const L = [];
  L.push(`# Informe de resultados — ${b.batch_id}`);
  L.push('> **SIMULACIÓN (MOCK).** Ningún contenido se ha publicado en redes sociales reales. Los IDs y URLs son ficticios (dominio .invalid).');
  L.push('');
  L.push(`Versión ${b.version} · Estado del lote **${b.status}** · Aprobado por ${b.approved_by ?? '—'} el ${fmtMadrid(b.approved_at)}`);
  L.push('');
  L.push('| # | Publicación | Plataforma | Estado | Intentos | ID (MOCK) | URL (MOCK) |');
  L.push('|---|---|---|---|---|---|---|');
  for (const p of pubs) L.push(`| ${p.seq} | ${p.publication_id} | ${p.platform} (${p.provider_mode ?? '—'}) | ${p.status} | ${p.attempts} | ${p.provider_post_id ?? '—'} | ${p.published_url ?? '—'} |`);
  const errs = pubs.flatMap((p) => p.errors.map((e) => `- ${p.publication_id} intento ${e.attempt} (${e.stage}): ${e.code} — ${e.message}${e.retryable ? ' [recuperable]' : ''}`));
  if (errs.length) { L.push(''); L.push('Errores registrados:'); L.push(...errs); }
  L.push('');
  L.push(`Versiones: ${versions.map((v) => `v${v.version} (${v.content_hash.slice(0, 12)}…)`).join(', ')} · Decisiones: ${approvals.map((a) => `v${a.version} ${a.decision}${a.valid ? ' (vigente)' : ' (invalidada)'}`).join(', ')}`);
  return {
    ...summary(b), mock: true, notice: 'SIMULACIÓN (MOCK): nada publicado en redes reales.',
    publications: pubs.map(slimPub), superseded_publications: all.filter((p) => p.batch_version !== b.version).map((p) => ({ publication_id: p.publication_id, status: p.status })),
    approvals, versions, events, report_markdown: L.join('\n'),
  };
}

const slimPub = (p) => ({
  publication_id: p.publication_id, seq: p.seq, batch_version: p.batch_version, platform: p.platform, content_type: p.content_type,
  media: { filename: p.media_filename, mime: p.media_mime, size_bytes: p.media_size, sha256: p.media_sha256 },
  scheduled_at: p.scheduled_at, status: p.status, provider: p.provider, provider_mode: p.provider_mode,
  provider_post_id: p.provider_post_id, published_url: p.published_url, attempts: p.attempts, next_retry_at: p.next_retry_at, errors: p.errors,
});
