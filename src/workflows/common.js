import { publicationId } from '../core/domain/batch.js';

export function toNormalizedPost(batch, version, hash, p) {
  const id = publicationId(batch.batch_id, version, p.seq);
  return {
    publication_id: id, batch_id: batch.batch_id, batch_version: version,
    platform: p.platform, content_type: p.content_type, media: p.media, copy: p.copy,
    scheduled_at: p.scheduled_at, settings: p.settings, test_controls: p.test_controls,
    idempotency_key: `${id}:${hash.slice(0, 16)}`,
  };
}

export const fmtMadrid = (iso) => iso ? new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(iso)) + ' (hora de Madrid)' : '—';
