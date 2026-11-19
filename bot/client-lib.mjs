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
  const list = Array.isArray(nested) ? nested : Object.values(nested);
  return list.filter((asset) => !asset?.role || asset.role === 'source');
}

function assetKey(asset) {
  return String(asset?.r2_key ?? asset?.key ?? asset?.object_key ?? '');
}

// Recalcula fuera del Worker: head de cada parte y SHA-256 del archivo juntado.
// head(key) devuelve metadatos y get(key) devuelve bytes. El Worker no hashea el cuerpo.
export async function verifyEncargoIntegrity(encargo, { head, get }) {
  if (typeof head !== 'function' || typeof get !== 'function') {
    const error = new Error('LECTURA_R2_NO_DISPONIBLE');
    error.code = 'INTEGRITY_READ_UNAVAILABLE';
    throw error;
  }
  const parts = [];
  const assets = [...encargoAssets(encargo)].sort((a, b) => assetKey(a).localeCompare(assetKey(b)));
  for (const asset of assets) {
    const key = assetKey(asset);
    if (!key) throw Object.assign(new Error('ENCARGO_SIN_CLAVE_R2'), { code: 'INTEGRITY_MISSING_KEY' });
    const announced = asset.sha256 ?? asset.checksums?.sha256;
    const info = await head(key);
    const headSha = info?.sha256 ?? info?.checksums?.sha256;
    const actualSize = info?.size ?? info?.size_bytes;
    if (announced && headSha && headSha !== announced) {
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
  const joined = Buffer.concat(parts);
  const fileSha256 = createHash('sha256').update(joined).digest('hex');
  const announcedFile = encargo.file_sha256 ?? encargo.media?.sha256 ?? encargo.sha256
    ?? encargo.upload_session?.file_sha256 ?? encargo.upload_session?.sha256 ?? encargo.upload_session?.sha256_file;
  if (announcedFile && fileSha256 !== announcedFile) {
    throw Object.assign(new Error('SHA256_ARCHIVO_NO_COINCIDE'), { code: 'INTEGRITY_FILE_MISMATCH', fileSha256 });
  }
  return { sha256: fileSha256, sizeBytes: joined.length, parts };
}

async function reportFailure(submitResult, id, error) {
  return submitResult(id, {
    failed: true,
    ...(typeof error.fileSha256 === 'string' ? { file_sha256: error.fileSha256 } : {}),
    error: { code: error.code ?? 'INTEGRITY_ERROR', message: error.message },
  }).catch(() => null);
}

// Una vuelta: cola vacía no reclama ni genera. Con encargo, reclama, comprueba el origen y responde.
export async function pollEncargoOnce(client, {
  head,
  get,
  generate,
  submitResult = (id, result) => client.submitEncargoResult(id, result),
} = {}) {
  const queue = await client.getQueuedEncargos();
  if (!queue.ok) return { ok: false, queue, phase: 'queue', generated: false };
  const items = encargoItems(queue);
  if (items.length === 0) return { ok: true, generated: false, items: [] };
  if (typeof generate !== 'function') {
    return {
      ok: false, generated: false, phase: 'generate',
      error: { code: 'GENERATOR_NOT_CONFIGURED', message: 'No hay generador para esta vuelta' },
    };
  }

  const encargo = items[0];
  const id = encargo.id ?? encargo.encargo_id;
  if (!id) return { ok: false, generated: false, error: { code: 'VALIDATION_ERROR', message: 'Encargo sin id' }, phase: 'claim' };
  const claimed = await client.claimEncargo(id);
  if (!claimed.ok) return { ok: false, generated: false, claimed, phase: 'claim' };
  const claimedEncargo = claimed.data?.encargo ?? claimed.encargo ?? claimed.data ?? encargo;

  let integrity = null;
  if (encargoAssets(claimedEncargo).length && typeof head === 'function' && typeof get === 'function') {
    try {
      integrity = await verifyEncargoIntegrity(claimedEncargo, { head, get });
    } catch (error) {
      const failure = await reportFailure(submitResult, id, error);
      return {
        ok: false, generated: false, phase: 'integrity', failure,
        error: { code: error.code ?? 'INTEGRITY_ERROR', message: error.message },
      };
    }
  }

  let piece;
  try {
    piece = await generate(claimedEncargo, integrity);
  } catch (error) {
    const failure = await reportFailure(submitResult, id, error);
    return {
      ok: false, generated: false, phase: 'generate', failure,
      error: { code: error.code ?? 'GENERATOR_ERROR', message: error.message },
    };
  }
  if (!piece) {
    const error = Object.assign(new Error('El generador no devolvió pieza'), { code: 'GENERATOR_NO_RESULT' });
    const failure = await reportFailure(submitResult, id, error);
    return { ok: false, generated: false, phase: 'generate', failure, error: { code: error.code, message: error.message } };
  }

  const synthetic = syntheticForEncargo(claimedEncargo, piece);
  const batch = piece.batch ?? piece.batch_id ?? claimedEncargo.batch_id ?? claimedEncargo.batch;
  const fileSha = integrity?.sha256 ?? claimedEncargo.file_sha256;
  const result = {
    ...piece.result,
    batch,
    batch_id: piece.batch_id ?? (typeof batch === 'string' ? batch : batch?.batch_id) ?? claimedEncargo.batch_id,
    synthetic,
    media: piece.media,
  };
  if (piece.content_hash && !result.content_hash) result.content_hash = piece.content_hash;
  if (piece.deliverable && !result.deliverable) result.deliverable = piece.deliverable;
  if (typeof fileSha === 'string') result.file_sha256 = fileSha;
  const sent = await submitResult(id, result);
  if (!sent.ok) return { ok: false, generated: false, sent, phase: 'result' };
  return { ok: true, generated: true, synthetic, integrity, encargo: claimedEncargo, result: sent };
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
