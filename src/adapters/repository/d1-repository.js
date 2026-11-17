// Adaptador BatchRepository sobre Cloudflare D1 (sustituto POC de n8n Data Tables).
// Las operaciones compuestas usan db.batch() => se ejecutan como una transacción.
import { publicationId } from '../../core/domain/batch.js';
import { PublicationStatus as PS } from '../../core/domain/states.js';

const j = (v) => JSON.stringify(v ?? null);

export class D1Repository {
  constructor(db) { this.db = db; }

  async getBatch(batchId) {
    const b = await this.db.prepare('SELECT b.*, v.payload_json FROM batches b JOIN batch_versions v ON v.batch_id = b.batch_id AND v.version = b.version WHERE b.batch_id = ?').bind(batchId).first();
    if (!b) return null;
    const { payload_json, validation_json, ...rest } = b;
    return { ...rest, payload: JSON.parse(payload_json), validation: validation_json ? JSON.parse(validation_json) : null };
  }

  async listBatches(limit = 50) {
    const r = await this.db.prepare('SELECT batch_id, version, status, content_hash, title, created_at, updated_at, approved_at, approved_by FROM batches ORDER BY updated_at DESC LIMIT ?').bind(limit).all();
    return r.results;
  }

  async listVersions(batchId) {
    const r = await this.db.prepare('SELECT version, content_hash, created_at, created_by, change_note FROM batch_versions WHERE batch_id = ? ORDER BY version').bind(batchId).all();
    return r.results;
  }

  /**
   * Registra una versión nueva (o la primera) del lote con sus publicaciones.
   * - Cancela las publicaciones de versiones anteriores no publicadas.
   * - Invalida cualquier aprobación vigente (la aprobación va ligada a versión + huella).
   */
  async insertBatchVersion({ batch, version, hash, status, pubStatus, actor, note, validation, now, isNew, invalidateReason }) {
    const stmts = [];
    if (isNew) {
      stmts.push(this.db.prepare('INSERT INTO batches (batch_id, version, status, content_hash, title, created_at, updated_at, validation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(batch.batch_id, version, status, hash, batch.title, now, now, j(validation)));
    } else {
      stmts.push(this.db.prepare('UPDATE batches SET version = ?, status = ?, content_hash = ?, title = ?, updated_at = ?, approved_at = NULL, approved_by = NULL, approved_version = NULL, approved_hash = NULL, validation_json = ? WHERE batch_id = ?')
        .bind(version, status, hash, batch.title, now, j(validation), batch.batch_id));
      stmts.push(this.db.prepare("UPDATE approvals SET valid = 0, invalidated_at = ?, invalidated_reason = ? WHERE batch_id = ? AND valid = 1")
        .bind(now, invalidateReason ?? `Nueva versión ${version}`, batch.batch_id));
      stmts.push(this.db.prepare("UPDATE publications SET status = 'CANCELLED', updated_at = ? WHERE batch_id = ? AND batch_version < ? AND status NOT IN ('PUBLISHED','CANCELLED')")
        .bind(now, batch.batch_id, version));
    }
    stmts.push(this.db.prepare('INSERT INTO batch_versions (batch_id, version, content_hash, payload_json, created_at, created_by, change_note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(batch.batch_id, version, hash, j(batch), now, actor, note ?? null));
    for (const p of batch.publications) {
      const id = publicationId(batch.batch_id, version, p.seq);
      stmts.push(this.db.prepare(`INSERT INTO publications (publication_id, batch_id, batch_version, seq, platform, content_type, media_sha256, media_mime, media_size, media_filename, post_json, scheduled_at, status, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, batch.batch_id, version, p.seq, p.platform, p.content_type, p.media.sha256, p.media.mime, p.media.size_bytes, p.media.filename, j(p), p.scheduled_at,
          pubStatus(p), `${id}:${hash.slice(0, 16)}`, now, now));
      stmts.push(this.db.prepare('INSERT INTO publication_events (publication_id, batch_id, at, op, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, batch.batch_id, now, 'REGISTERED', null, pubStatus(p), j({ version })));
    }
    await this.db.batch(stmts);
  }

  async listPublications(batchId, version) {
    const r = version === undefined
      ? await this.db.prepare('SELECT * FROM publications WHERE batch_id = ? ORDER BY batch_version, seq').bind(batchId).all()
      : await this.db.prepare('SELECT * FROM publications WHERE batch_id = ? AND batch_version = ? ORDER BY seq').bind(batchId, version).all();
    return r.results.map(parsePub);
  }

  async listDispatchableBatches(batchId) {
    const q = batchId
      ? this.db.prepare("SELECT batch_id FROM batches WHERE status IN ('APPROVED','PUBLISHING') AND batch_id = ?").bind(batchId)
      : this.db.prepare("SELECT batch_id FROM batches WHERE status IN ('APPROVED','PUBLISHING') ORDER BY updated_at LIMIT 10");
    return (await q.all()).results.map((r) => r.batch_id);
  }

  /** Decisión explícita + cambios de estado asociados, en una única transacción. */
  async recordDecision({ batchId, version, hash, decision, decidedBy, keyId, commandText, comment, now, batchStatus, pubUpdates }) {
    const stmts = [
      this.db.prepare("UPDATE approvals SET valid = 0, invalidated_at = ?, invalidated_reason = ? WHERE batch_id = ? AND valid = 1").bind(now, `Sustituida por decisión ${decision}`, batchId),
      this.db.prepare('INSERT INTO approvals (batch_id, version, content_hash, decision, decided_by, decided_at, command_text, comment, key_id, valid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(batchId, version, hash, decision, decidedBy, now, commandText ?? null, comment ?? null, keyId, decision === 'APPROVE' ? 1 : 0),
      decision === 'APPROVE'
        ? this.db.prepare('UPDATE batches SET status = ?, approved_at = ?, approved_by = ?, approved_version = ?, approved_hash = ?, updated_at = ? WHERE batch_id = ? AND version = ? AND content_hash = ?')
          .bind(batchStatus, now, decidedBy, version, hash, now, batchId, version, hash)
        : this.db.prepare('UPDATE batches SET status = ?, approved_at = NULL, approved_by = NULL, approved_version = NULL, approved_hash = NULL, updated_at = ? WHERE batch_id = ? AND version = ?')
          .bind(batchStatus, now, batchId, version),
    ];
    for (const u of pubUpdates) {
      stmts.push(this.db.prepare('UPDATE publications SET status = ?, updated_at = ? WHERE publication_id = ?').bind(u.to, now, u.id));
      stmts.push(this.db.prepare('INSERT INTO publication_events (publication_id, batch_id, at, op, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(u.id, batchId, now, `DECISION_${decision}`, u.from, u.to, j({ version, decided_by: decidedBy })));
    }
    const res = await this.db.batch(stmts);
    return res[2].meta.changes === 1;
  }

  async getValidApproval(batchId) {
    return this.db.prepare('SELECT * FROM approvals WHERE batch_id = ? AND valid = 1 AND decision = ? ORDER BY id DESC LIMIT 1').bind(batchId, 'APPROVE').first();
  }

  async listApprovals(batchId) {
    return (await this.db.prepare('SELECT id, version, content_hash, decision, decided_by, decided_at, command_text, comment, valid, invalidated_at, invalidated_reason FROM approvals WHERE batch_id = ? ORDER BY id').bind(batchId).all()).results;
  }

  /** Reclamo atómico: solo un despachador puede pasar una publicación a PUBLISHING. */
  async claimPublication(pubId, now) {
    const r = await this.db.prepare(`UPDATE publications SET status = 'PUBLISHING', attempts = attempts + 1, updated_at = ?
      WHERE publication_id = ? AND status IN ('READY','SCHEDULED','RETRY_PENDING') AND scheduled_at <= ? AND (next_retry_at IS NULL OR next_retry_at <= ?)`)
      .bind(now, pubId, now, now).run();
    return r.meta.changes === 1;
  }

  async savePublicationOutcome(pub, f, events, now) {
    const stmts = [this.db.prepare(`UPDATE publications SET status = ?, provider = ?, provider_mode = ?, provider_post_id = COALESCE(?, provider_post_id), published_url = COALESCE(?, published_url),
      errors_json = ?, next_retry_at = ?, updated_at = ? WHERE publication_id = ?`)
      .bind(f.status, f.provider ?? null, f.provider_mode ?? null, f.provider_post_id ?? null, f.published_url ?? null, j(f.errors ?? []), f.next_retry_at ?? null, now, pub.publication_id)];
    for (const e of events) {
      stmts.push(this.db.prepare('INSERT INTO publication_events (publication_id, batch_id, at, op, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(pub.publication_id, pub.batch_id, e.at ?? now, e.op, e.from ?? null, e.to ?? null, j(e.detail)));
    }
    await this.db.batch(stmts);
  }

  async setPublicationStatus(batchId, ids, to, op, now) {
    if (!ids.length) return;
    await this.db.batch(ids.flatMap(({ id, from }) => [
      this.db.prepare('UPDATE publications SET status = ?, updated_at = ? WHERE publication_id = ? AND status = ?').bind(to, now, id, from),
      this.db.prepare('INSERT INTO publication_events (publication_id, batch_id, at, op, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, batchId, now, op, from, to, null),
    ]));
  }

  async updateBatchStatus(batchId, status, now) {
    await this.db.prepare('UPDATE batches SET status = ?, updated_at = ? WHERE batch_id = ?').bind(status, now, batchId).run();
  }

  async listEvents(batchId) {
    return (await this.db.prepare('SELECT publication_id, at, op, from_status, to_status, detail_json FROM publication_events WHERE batch_id = ? ORDER BY id').bind(batchId).all())
      .results.map((e) => ({ ...e, detail: e.detail_json ? JSON.parse(e.detail_json) : null, detail_json: undefined }));
  }

  async audit(actor, action, batchId, detail, now = new Date().toISOString()) {
    await this.db.prepare('INSERT INTO audit_log (at, actor, action, batch_id, detail_json) VALUES (?, ?, ?, ?, ?)').bind(now, actor, action, batchId ?? null, j(detail)).run();
  }

  async listAudit(batchId, limit = 100) {
    const q = batchId
      ? this.db.prepare('SELECT at, actor, action, batch_id, detail_json FROM audit_log WHERE batch_id = ? ORDER BY id DESC LIMIT ?').bind(batchId, limit)
      : this.db.prepare('SELECT at, actor, action, batch_id, detail_json FROM audit_log ORDER BY id DESC LIMIT ?').bind(limit);
    return (await q.all()).results;
  }

  /** Protección anti-replay: un nonce solo puede usarse una vez. */
  async useNonce(nonce, keyId, now) {
    try {
      await this.db.prepare('INSERT INTO nonces (nonce, key_id, at) VALUES (?, ?, ?)').bind(nonce, keyId, now).run();
      return true;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return false;
      throw e;
    }
  }

  async purgeNonces(beforeIso) {
    await this.db.prepare('DELETE FROM nonces WHERE at < ?').bind(beforeIso).run();
  }

  async logEgress(entries) {
    if (!entries.length) return;
    await this.db.batch(entries.map((e) => this.db.prepare('INSERT INTO egress_log (at, host, url, allowed, context) VALUES (?, ?, ?, ?, ?)').bind(e.at, e.host, e.url, e.allowed ? 1 : 0, e.context ?? null)));
  }

  async listEgress() {
    const rows = (await this.db.prepare('SELECT at, host, url, allowed, context FROM egress_log ORDER BY id DESC LIMIT 200').all()).results;
    const total = await this.db.prepare('SELECT COUNT(*) AS n FROM egress_log').first();
    return { total: total.n, rows };
  }
}

function parsePub(r) {
  return { ...r, post: JSON.parse(r.post_json), errors: JSON.parse(r.errors_json || '[]'), post_json: undefined, errors_json: undefined };
}

export { PS };
