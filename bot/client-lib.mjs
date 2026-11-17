// Cliente de Grok Bot para el orquestador (submitBatch, getBatchStatus, approveBatch, rejectBatch,
// requestBatchChanges, getPublicationResults...). Firma cada petición con HMAC-SHA256.
// Independiente del transporte: `transport` puede ser fetch real o un Worker en memoria (tests).
import { createHmac, createHash, randomBytes } from 'node:crypto';

export function sign({ secret, keyId, method, pathAndQuery, body }) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString('base64url');
  const bodyHash = createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
  const s = ['v1', ts, nonce, method.toUpperCase(), pathAndQuery, bodyHash].join('\n');
  return {
    'x-influ-key-id': keyId, 'x-influ-timestamp': ts, 'x-influ-nonce': nonce,
    'x-influ-signature': 'v1=' + createHmac('sha256', secret).update(s).digest('hex'),
  };
}

export class OrchestratorClient {
  constructor({ baseUrl, botSecret, approverSecret, transport = globalThis.fetch }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), transport });
    // Los secretos quedan en propiedades no enumerables para que nunca se impriman por accidente.
    Object.defineProperty(this, 'secrets', { value: { bot: botSecret, approver: approverSecret }, enumerable: false });
  }

  async call(method, path, { body, keyId = 'bot', raw, contentType, headers = {}, signOverride } = {}) {
    const bytes = raw ?? (body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined);
    const secret = this.secrets[keyId];
    const auth = signOverride ?? (secret ? sign({ secret, keyId, method, pathAndQuery: path, body: bytes }) : {});
    const res = await this.transport(this.baseUrl + path, {
      method, body: bytes, headers: { ...(bytes ? { 'content-type': contentType ?? 'application/json' } : {}), ...auth, ...headers },
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { ok: false, error: { code: 'NON_JSON', message: text.slice(0, 200) } }; }
    return { status: res.status, ...json };
  }

  health() { return this.call('GET', '/v1/health', { keyId: 'none' }); }
  uploadMedia(sha256, bytes, mime, filename) { return this.call('PUT', `/v1/media/${sha256}`, { raw: Buffer.from(bytes), contentType: mime, headers: { 'x-media-filename': filename } }); }
  submitBatch(batch) { return this.call('POST', '/v1/batches', { body: batch }); }
  updateBatch(batch, changeNote) { return this.call('PUT', `/v1/batches/${batch.batch_id}`, { body: { ...batch, change_note: changeNote } }); }
  getBatchStatus(id) { return this.call('GET', `/v1/batches/${id}`); }
  getReview(id) { return this.call('GET', `/v1/batches/${id}/review`); }
  decide(id, { commandText, version, contentHash, decidedBy }) {
    return this.call('POST', `/v1/batches/${id}/decision`, { keyId: 'approver', body: { command_text: commandText, version, content_hash: contentHash, decided_by: decidedBy } });
  }
  approveBatch(id, o) { return this.decide(id, { ...o, commandText: `APROBAR ${id}` }); }
  rejectBatch(id, o) { return this.decide(id, { ...o, commandText: `RECHAZAR ${id}` }); }
  requestBatchChanges(id, o) { return this.decide(id, { ...o, commandText: `CAMBIOS ${id}: ${o.comment}` }); }
  publishBatch(id) { return this.call('POST', `/v1/batches/${id}/publish`); }
  dispatch(batchId) { return this.call('POST', '/v1/dispatch', { body: batchId ? { batch_id: batchId } : {} }); }
  getPublicationResults(id) { return this.call('GET', `/v1/batches/${id}/results`); }
  audit(batchId) { return this.call('GET', `/v1/audit${batchId ? `?batch_id=${batchId}` : ''}`); }
  egress() { return this.call('GET', '/v1/egress'); }
}

// Prepara un lote desde un archivo batch.json con rutas locales de media (media.path).
export async function materializeBatch(batchDef, baseDir, { probe } = {}) {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const files = [];
  const publications = batchDef.publications.map((p) => {
    const path = join(baseDir, p.media.path);
    const bytes = readFileSync(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const info = probe ? probe(path) : {};
    files.push({ sha256, bytes, mime: p.media.mime, filename: p.media.path.split('/').pop() });
    const { path: _, ...mediaRest } = p.media;
    return { ...p, media: { ...mediaRest, sha256, size_bytes: bytes.length, filename: p.media.path.split('/').pop(), ...info } };
  });
  return { batch: { ...batchDef, publications }, files };
}
