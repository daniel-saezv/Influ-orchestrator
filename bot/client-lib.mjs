// Cliente de Grok Bot para el orquestador (submitBatch, getBatchStatus, approveBatch, rejectBatch,
// requestBatchChanges, getPublicationResults...). Firma cada petición con HMAC-SHA256.
// Independiente del transporte: `transport` puede ser fetch real o un Worker en memoria (tests).
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { accessHeadersFromEnv } from './access-headers.mjs';

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
  constructor({ baseUrl, botSecret, approverSecret, transport = globalThis.fetch, accessHeaders }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), transport });
    // Los secretos quedan en propiedades no enumerables para que nunca se impriman por accidente.
    Object.defineProperty(this, 'secrets', { value: { bot: botSecret, approver: approverSecret }, enumerable: false });
    Object.defineProperty(this, 'accessHeaders', { value: accessHeaders ?? accessHeadersFromEnv(), enumerable: false });
  }

  async call(method, path, { body, keyId = 'bot', raw, contentType, headers = {}, signOverride } = {}) {
    const bytes = raw ?? (body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined);
    const secret = keyId === 'none' ? undefined : this.secrets[keyId];
    const auth = signOverride ?? (secret ? sign({ secret, keyId, method, pathAndQuery: path, body: bytes }) : {});
    const res = await this.transport(this.baseUrl + path, {
      method, body: bytes, headers: { ...this.accessHeaders, ...(bytes ? { 'content-type': contentType ?? 'application/json' } : {}), ...auth, ...headers },
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

  getQueuedEncargos() { return this.call('GET', '/v1/encargos?status=queued'); }
  claimEncargo(id) { return this.call('POST', `/v1/encargos/${encodeURIComponent(id)}/claim`); }
  submitEncargoResult(id, result) { return this.call('POST', `/v1/encargos/${encodeURIComponent(id)}/result`, { body: result }); }
}

export function syntheticForEncargo(encargo, generatedResult = {}) {
  if (encargo?.kind === 'from_scratch') return true;
  if (encargo?.kind === 'edit') {
    if (generatedResult.synthetic !== undefined) return generatedResult.synthetic !== false;
    return generatedResult.altered === true || generatedResult.operation === 'generate'
      || generatedResult.operation === 'alter';
  }
  return generatedResult.synthetic === true;
}

function encargoItems(response) {
  return response?.data?.items ?? response?.data?.encargos ?? response?.items ?? response?.encargos ?? [];
}

export function encargoAssets(encargo) {
  const nested = encargo?.assets ?? encargo?.media ?? encargo?.encargo_assets ?? [];
  return Array.isArray(nested) ? nested : Object.values(nested);
}

// Lee integridad fuera del Worker. Las funciones head/get se pasan desde el runtime:
// head(key) devuelve metadata y get(key) devuelve bytes. Si A/F aún no publica lectura
// para el bot, ambas operaciones quedan sin ejecutar y el encargo puede marcarse failed.
export async function verifyEncargoIntegrity(encargo, { head, get }) {
  if (typeof head !== 'function' || typeof get !== 'function') {
    const error = new Error('LECTURA_R2_NO_DISPONIBLE');
    error.code = 'INTEGRITY_READ_UNAVAILABLE';
    throw error;
  }
  const parts = [];
  for (const asset of encargoAssets(encargo)) {
    const key = asset.r2_key ?? asset.key ?? asset.object_key;
    if (!key) throw Object.assign(new Error('ENCARGO_SIN_CLAVE_R2'), { code: 'INTEGRITY_MISSING_KEY' });
    const announced = asset.sha256 ?? asset.checksums?.sha256;
    const info = await head(key);
    const actualSize = info?.size ?? info?.size_bytes;
    if (announced && (info?.sha256 ?? info?.checksums?.sha256) && (info?.sha256 ?? info?.checksums?.sha256) !== announced) {
      throw Object.assign(new Error('SHA256_PARTE_NO_COINCIDE'), { code: 'INTEGRITY_PART_MISMATCH', key });
    }
    if (asset.size_bytes !== undefined && actualSize !== undefined && Number(asset.size_bytes) !== Number(actualSize)) {
      throw Object.assign(new Error('TAMANO_PARTE_NO_COINCIDE'), { code: 'INTEGRITY_SIZE_MISMATCH', key });
    }
    const bytes = Buffer.from(await get(key));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (announced && sha256 !== announced) {
      throw Object.assign(new Error('BYTES_PARTE_NO_COINCIDEN'), { code: 'INTEGRITY_BYTES_MISMATCH', key });
    }
    parts.push(bytes);
  }
  if (!parts.length) throw Object.assign(new Error('ENCARGO_SIN_PARTES'), { code: 'INTEGRITY_NO_PARTS' });
  const fileSha256 = createHash('sha256').update(Buffer.concat(parts)).digest('hex');
  const announcedFile = encargo.media?.sha256 ?? encargo.sha256
    ?? encargo.upload_session?.sha256 ?? encargo.upload_session?.sha256_file;
  if (announcedFile && fileSha256 !== announcedFile) {
    throw Object.assign(new Error('SHA256_ARCHIVO_NO_COINCIDE'), { code: 'INTEGRITY_FILE_MISMATCH' });
  }
  return { sha256: fileSha256, sizeBytes: Buffer.concat(parts).length, parts };
}

export async function pollEncargoOnce(client, {
  head,
  get,
  generate,
  submitResult = (id, result) => client.submitEncargoResult(id, result),
} = {}) {
  const queue = await client.getQueuedEncargos();
  if (!queue.ok) return { ok: false, queue, phase: 'queue' };
  const items = encargoItems(queue);
  if (items.length === 0) return { ok: true, generated: false, items: [] };

  const encargo = items[0];
  const id = encargo.id ?? encargo.encargo_id;
  if (!id) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Encargo sin id' }, phase: 'claim' };
  const claimed = await client.claimEncargo(id);
  if (!claimed.ok) return { ok: false, claimed, phase: 'claim' };
  const claimedEncargo = claimed.data?.encargo ?? claimed.encargo ?? claimed.data ?? encargo;

  try {
    const integrity = await verifyEncargoIntegrity(claimedEncargo, { head, get });
    if (typeof generate !== 'function') {
      throw Object.assign(new Error('GENERADOR_NO_CONFIGURADO'), { code: 'GENERATOR_NOT_CONFIGURED' });
    }
    const piece = await generate(claimedEncargo, integrity);
    if (!piece) throw Object.assign(new Error('GENERADOR_SIN_PIEZA'), { code: 'GENERATOR_NO_RESULT' });
    const synthetic = syntheticForEncargo(claimedEncargo, piece);
    const batch = piece.batch ?? piece.batch_id ?? claimedEncargo.batch_id ?? claimedEncargo.batch;
    const result = {
      ...piece.result,
      batch,
      batch_id: piece.batch_id ?? (typeof batch === 'string' ? batch : batch?.batch_id) ?? claimedEncargo.batch_id,
      synthetic,
      media: piece.media,
    };
    const sent = await submitResult(id, result);
    if (!sent.ok) return { ok: false, sent, phase: 'result' };
    return { ok: true, generated: true, synthetic, integrity, encargo: claimedEncargo, result: sent };
  } catch (error) {
    // The documented result route is the only route that can return failure context.
    // No alternate failure route is invented.
    const failure = await submitResult(id, {
      failed: true,
      error: { code: error.code ?? 'INTEGRITY_ERROR', message: error.message },
    }).catch(() => null);
    return { ok: false, error: { code: error.code ?? 'INTEGRITY_ERROR', message: error.message }, phase: 'integrity', failure };
  }
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
