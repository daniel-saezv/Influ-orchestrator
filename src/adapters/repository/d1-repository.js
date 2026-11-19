// Adaptador BatchRepository sobre Cloudflare D1 (sustituto POC de n8n Data Tables).
// Las operaciones compuestas usan db.batch() => se ejecutan como una transacción.
import { publicationId } from '../../core/domain/batch.js';
import { shiftUtcDay } from '../../core/domain/r2-quota.js';
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

  async lastBackupReviewDay() {
    const row = await this.db.prepare(
      `SELECT detail_json FROM audit_log WHERE action = 'ENCARGO_BACKUP_CHECKED' ORDER BY id DESC LIMIT 1`,
    ).first();
    if (!row?.detail_json) return null;
    try { return JSON.parse(row.detail_json).day ?? null; } catch { return null; }
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

  async ensureUser(email, now) {
    const existing = await this.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (existing) return existing;
    const userId = crypto.randomUUID();
    try {
      await this.db.prepare('INSERT INTO users (user_id, email, display_name, time_zone, guide_seen_at, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, ?, ?)').bind(userId, email, now, now).run();
    } catch (e) {
      if (!String(e.message ?? e).includes('UNIQUE')) throw e;
    }
    return this.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  }

  async listAccounts(userId) {
    const r = await this.db.prepare('SELECT account_id, name FROM accounts WHERE user_id = ? ORDER BY created_at').bind(userId).all();
    return r.results;
  }

  async saveGuide(userId, { displayName, timeZone, now }) {
    await this.db.prepare('UPDATE users SET display_name = ?, time_zone = ?, guide_seen_at = COALESCE(guide_seen_at, ?), updated_at = ? WHERE user_id = ?')
      .bind(displayName, timeZone, now, now, userId).run();
    const accounts = await this.listAccounts(userId);
    if (accounts.length === 0) {
      const accountId = crypto.randomUUID();
      await this.db.prepare('INSERT INTO accounts (account_id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(accountId, userId, displayName, now, now).run();
    }
    return this.db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
  }

  async renameUser(userId, displayName, timeZone, now) {
    if (timeZone) {
      await this.db.prepare('UPDATE users SET display_name = ?, time_zone = ?, updated_at = ? WHERE user_id = ?').bind(displayName, timeZone, now, userId).run();
    } else {
      await this.db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE user_id = ?').bind(displayName, now, userId).run();
    }
    return this.db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
  }

  async ownedAccount(email, accountId) {
    return this.db.prepare(`SELECT a.account_id, a.user_id, a.name, u.email, u.time_zone, u.guide_seen_at
      FROM accounts a JOIN users u ON u.user_id = a.user_id
      WHERE a.account_id = ? AND u.email = ?`).bind(accountId, email).first();
  }

  async createAccount(userId, name, now) {
    const accountId = crypto.randomUUID();
    await this.db.prepare('INSERT INTO accounts (account_id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(accountId, userId, name, now, now).run();
    return { account_id: accountId, name };
  }

  async renameAccount(accountId, name, now) {
    await this.db.prepare('UPDATE accounts SET name = ?, updated_at = ? WHERE account_id = ?').bind(name, now, accountId).run();
    return { account_id: accountId, name };
  }

  async insertEncargo({ accountId, kind, note, status, platforms, now }) {
    const encargoId = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare(`INSERT INTO encargos (encargo_id, account_id, kind, note, status, platforms_json, version, delivered, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`).bind(encargoId, accountId, kind, note, status, j(platforms), now, now),
      this.db.prepare('INSERT INTO encargo_events (account_id, encargo_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)')
        .bind(accountId, encargoId, now, 'created', j({ kind, platforms })),
    ]);
    return encargoId;
  }

  async encargoForEmail(email, encargoId) {
    const row = await this.db.prepare(`SELECT e.*, a.user_id, a.name AS account_name, u.email, u.time_zone
      FROM encargos e
      JOIN accounts a ON a.account_id = e.account_id
      JOIN users u ON u.user_id = a.user_id
      WHERE e.encargo_id = ? AND u.email = ?`).bind(encargoId, email).first();
    return row ? parseEncargo(row) : null;
  }

  async encargoById(encargoId) {
    const row = await this.db.prepare(`SELECT e.*, a.user_id, a.name AS account_name
      FROM encargos e JOIN accounts a ON a.account_id = e.account_id
      WHERE e.encargo_id = ?`).bind(encargoId).first();
    return row ? parseEncargo(row) : null;
  }

  async listQueuedEncargos() {
    const rows = (await this.db.prepare(`SELECT e.encargo_id, e.account_id, a.name AS account_name, e.kind, e.note, e.platforms_json, e.version,
      (SELECT u.file_sha256 FROM upload_sessions u
        WHERE u.encargo_id = e.encargo_id AND u.completed_at IS NOT NULL
        ORDER BY u.completed_at DESC LIMIT 1) AS file_sha256
      FROM encargos e JOIN accounts a ON a.account_id = e.account_id
      WHERE e.status = 'queued' ORDER BY e.created_at LIMIT 20`).all()).results;
    const assets = (await this.db.prepare(`SELECT s.encargo_id, s.role, s.r2_key, s.sha256, s.mime, s.size_bytes, s.version
      FROM encargo_assets s JOIN encargos e ON e.encargo_id = s.encargo_id
      WHERE e.status = 'queued' AND s.role = 'source' AND s.delete_pending = 0
      ORDER BY s.r2_key`).all()).results;
    return rows.map((row) => ({
      encargo_id: row.encargo_id,
      account_id: row.account_id,
      account_name: row.account_name,
      kind: row.kind,
      note: row.note,
      platforms: JSON.parse(row.platforms_json),
      version: row.version,
      file_sha256: row.file_sha256 ?? null,
      assets: assets.filter((a) => a.encargo_id === row.encargo_id).map(({ encargo_id, ...rest }) => rest),
    }));
  }

  async listSourceAssets(encargoId) {
    const r = await this.db.prepare(`SELECT role, r2_key, sha256, mime, size_bytes, version
      FROM encargo_assets
      WHERE encargo_id = ? AND role = 'source' AND delete_pending = 0
      ORDER BY r2_key`).bind(encargoId).all();
    return r.results;
  }

  async sourceFileSha(encargoId) {
    const row = await this.db.prepare(`SELECT file_sha256 FROM upload_sessions
      WHERE encargo_id = ? AND completed_at IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1`).bind(encargoId).first();
    return row?.file_sha256 ?? null;
  }

  async failEncargo(encargoId, now) {
    const r = await this.db.prepare(`UPDATE encargos SET status = 'failed', updated_at = ? WHERE encargo_id = ? AND status = 'claimed'`)
      .bind(now, encargoId).run();
    return r.meta.changes === 1;
  }

  async claimEncargo(encargoId, now) {
    const r = await this.db.prepare(`UPDATE encargos SET status = 'claimed', updated_at = ? WHERE encargo_id = ? AND status = 'queued'`).bind(now, encargoId).run();
    return r.meta.changes === 1;
  }

  async addEncargoAsset({ encargoId, userId, role, r2Key, sha256, mime, sizeBytes, version, now, contentMd5 = null, countBytes = true }) {
    const assetId = crypto.randomUUID();
    const stmts = [
      this.db.prepare(`INSERT INTO encargo_assets (asset_id, encargo_id, role, r2_key, sha256, mime, size_bytes, version, created_at, content_md5)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(assetId, encargoId, role, r2Key, sha256, mime, sizeBytes, version, now, contentMd5),
    ];
    if (countBytes) {
      stmts.push(
        this.db.prepare(`INSERT INTO r2_bytes (scope, bytes_stored) VALUES ('global', ?)
          ON CONFLICT(scope) DO UPDATE SET bytes_stored = bytes_stored + excluded.bytes_stored`).bind(sizeBytes),
        this.db.prepare(`INSERT INTO r2_bytes (scope, bytes_stored) VALUES (?, ?)
          ON CONFLICT(scope) DO UPDATE SET bytes_stored = bytes_stored + excluded.bytes_stored`).bind(userId, sizeBytes),
      );
    }
    await this.db.batch(stmts);
    return assetId;
  }

  async finishEncargoResult({ encargoId, version, contentHash, synthetic, batchId, now }) {
    const r = await this.db.prepare(`UPDATE encargos
      SET status = 'ready', version = ?, content_hash = ?, synthetic = ?, delivered = 1, batch_id = COALESCE(?, batch_id), updated_at = ?
      WHERE encargo_id = ? AND status = 'claimed'`).bind(version, contentHash, synthetic ? 1 : 0, batchId ?? null, now, encargoId).run();
    return r.meta.changes === 1;
  }

  async attachBatchToAccount(batchId, accountId) {
    const row = await this.db.prepare('SELECT account_id FROM batches WHERE batch_id = ?').bind(batchId).first();
    if (!row) return 'missing';
    if (row.account_id && row.account_id !== accountId) return 'foreign';
    if (!row.account_id) {
      await this.db.prepare('UPDATE batches SET account_id = ? WHERE batch_id = ? AND account_id IS NULL').bind(accountId, batchId).run();
    }
    return 'ok';
  }

  async mediaForEmail(email, sha256) {
    return this.db.prepare(`SELECT s.sha256, s.mime, s.size_bytes, s.role, s.encargo_id, s.r2_key, s.delete_pending, s.content_md5
      FROM encargo_assets s
      JOIN encargos e ON e.encargo_id = s.encargo_id
      JOIN accounts a ON a.account_id = e.account_id
      JOIN users u ON u.user_id = a.user_id
      WHERE s.sha256 = ? AND u.email = ? LIMIT 1`).bind(sha256, email).first();
  }

  async sumAssets(encargoId, { role, versions } = {}) {
    const row = role && versions
      ? await this.db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM encargo_assets
        WHERE encargo_id = ? AND role = ? AND version IN (?, ?)`).bind(encargoId, role, versions[0], versions[1]).first()
      : await this.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM encargo_assets WHERE encargo_id = ?').bind(encargoId).first();
    return Number(row?.n ?? 0);
  }

  async beginDiscard({ encargoId, accountId, version, note, now }) {
    const rows = await this.listAssets(encargoId, { role: 'deliverable', versions: [version, version - 1] });
    const updated = await this.db.prepare(`UPDATE encargos SET status = 'queued', note = COALESCE(?, note), content_hash = NULL, publish_at = NULL, updated_at = ? WHERE encargo_id = ? AND status IN ('ready', 'approved', 'scheduled')`).bind(note ?? null, now, encargoId).run();
    if (updated.meta.changes !== 1) return { changed: false, rows: [] };
    const stmts = [
      this.db.prepare('INSERT INTO encargo_events (account_id, encargo_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)').bind(accountId, encargoId, now, 'changes', j({ version, note })),
    ];
    for (const row of rows) {
      stmts.push(this.db.prepare('UPDATE encargo_assets SET delete_pending = 1 WHERE asset_id = ?').bind(row.asset_id));
    }
    await this.db.batch(stmts);
    return { changed: true, rows };
  }

  async beginCancel({ encargoId, accountId, now }) {
    const rows = await this.listAssets(encargoId);
    const updated = await this.db.prepare(`UPDATE encargos SET status = 'cancelled', publish_at = NULL, updated_at = ? WHERE encargo_id = ? AND status != 'cancelled'`).bind(now, encargoId).run();
    if (updated.meta.changes !== 1) return { changed: false, rows: [] };
    const stmts = [
      this.db.prepare('INSERT INTO encargo_events (account_id, encargo_id, at, kind, detail_json) VALUES (?, ?, ?, ?, NULL)').bind(accountId, encargoId, now, 'cancelled'),
    ];
    for (const row of rows) {
      stmts.push(this.db.prepare('UPDATE encargo_assets SET delete_pending = 1 WHERE asset_id = ?').bind(row.asset_id));
    }
    await this.db.batch(stmts);
    return { changed: true, rows };
  }

  async markApproved(encargoId, accountId, version, contentHash, now) {
    const updated = await this.db.prepare(`UPDATE encargos SET status = 'approved', updated_at = ? WHERE encargo_id = ? AND status = 'ready' AND version = ? AND content_hash = ?`)
      .bind(now, encargoId, version, contentHash).run();
    if (updated.meta.changes !== 1) return false;
    await this.db.prepare('INSERT INTO encargo_events (account_id, encargo_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)')
      .bind(accountId, encargoId, now, 'approved', j({ version })).run();
    return true;
  }

  async markScheduled(encargoId, accountId, publishAt, platforms, now) {
    const updated = await this.db.prepare(`UPDATE encargos SET status = 'scheduled', publish_at = ?, updated_at = ? WHERE encargo_id = ? AND status = 'approved'`)
      .bind(publishAt, now, encargoId).run();
    if (updated.meta.changes !== 1) return false;
    await this.db.prepare('INSERT INTO encargo_events (account_id, encargo_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)')
      .bind(accountId, encargoId, now, 'scheduled', j({ publish_at: publishAt, platforms })).run();
    return true;
  }

  async streakRow(accountId) {
    return this.db.prepare('SELECT count, last_civil_day FROM streaks WHERE account_id = ?').bind(accountId).first();
  }

  async saveStreak(accountId, count, day, now) {
    await this.db.prepare(`INSERT INTO streaks (account_id, count, last_civil_day, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET count = excluded.count, last_civil_day = excluded.last_civil_day, updated_at = excluded.updated_at`)
      .bind(accountId, count, day, now).run();
  }

  async listActivity(accountId) {
    const rows = (await this.db.prepare('SELECT at, kind, encargo_id, detail_json FROM encargo_events WHERE account_id = ? ORDER BY id DESC LIMIT 50').bind(accountId).all()).results;
    return rows.map((row) => ({ ...row, detail: row.detail_json ? JSON.parse(row.detail_json) : null, detail_json: undefined }));
  }

  async listConnections(accountId) {
    return (await this.db.prepare('SELECT connection_id, platform, created_at FROM platform_connections WHERE account_id = ? ORDER BY created_at').bind(accountId).all()).results;
  }

  async connectionForEmail(email, connectionId) {
    return this.db.prepare(`SELECT c.connection_id, c.platform, c.created_at
      FROM platform_connections c
      JOIN accounts a ON a.account_id = c.account_id
      JOIN users u ON u.user_id = a.user_id
      WHERE c.connection_id = ? AND u.email = ?`).bind(connectionId, email).first();
  }

  async storedBytes(scope) {
    const row = await this.db.prepare('SELECT bytes_stored FROM r2_bytes WHERE scope = ?').bind(scope).first();
    return row?.bytes_stored ?? 0;
  }

  async countConnections() {
    return (await this.db.prepare('SELECT COUNT(*) AS n FROM platform_connections').first()).n;
  }

  async recordEncargoEvent(accountId, encargoId, now, kind, detail) {
    await this.db.prepare('INSERT INTO encargo_events (account_id, encargo_id, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)')
      .bind(accountId, encargoId, now, kind, j(detail)).run();
  }

  async userByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  }

  async countAssets(encargoId, role) {
    const row = role
      ? await this.db.prepare('SELECT COUNT(*) AS n FROM encargo_assets WHERE encargo_id = ? AND role = ?').bind(encargoId, role).first()
      : await this.db.prepare('SELECT COUNT(*) AS n FROM encargo_assets WHERE encargo_id = ?').bind(encargoId).first();
    return Number(row?.n ?? 0);
  }

  async listAssets(encargoId, { role, versions } = {}) {
    const r = role && versions
      ? await this.db.prepare(`SELECT * FROM encargo_assets WHERE encargo_id = ? AND role = ? AND version IN (?, ?)`).bind(encargoId, role, versions[0], versions[1]).all()
      : await this.db.prepare('SELECT * FROM encargo_assets WHERE encargo_id = ?').bind(encargoId).all();
    return r.results;
  }

  async encargoByBatch(batchId) {
    const row = await this.db.prepare(`SELECT e.*, a.user_id, a.name AS account_name
      FROM encargos e JOIN accounts a ON a.account_id = e.account_id
      WHERE e.batch_id = ? LIMIT 1`).bind(batchId).first();
    return row ? parseEncargo(row) : null;
  }

  async assetBySha(sha256) {
    return this.db.prepare(`SELECT s.asset_id, s.encargo_id, s.role, s.r2_key, s.sha256, s.mime, s.size_bytes, s.version, s.delete_pending, a.user_id
      FROM encargo_assets s
      JOIN encargos e ON e.encargo_id = s.encargo_id
      JOIN accounts a ON a.account_id = e.account_id
      WHERE s.sha256 = ? AND s.delete_pending = 0
      LIMIT 1`).bind(sha256).first();
  }

  async holdPublicationsUntilSchedule(batchId, version, now) {
    const pubs = await this.listPublications(batchId, version);
    const stmts = [];
    for (const p of pubs) {
      if (!['READY', 'SCHEDULED'].includes(p.status)) continue;
      stmts.push(this.db.prepare(`UPDATE publications SET status = 'VALIDATED', updated_at = ? WHERE publication_id = ? AND status = ?`).bind(now, p.publication_id, p.status));
      stmts.push(this.db.prepare('INSERT INTO publication_events (publication_id, batch_id, at, op, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(p.publication_id, batchId, now, 'HOLD_FOR_SCHEDULE', p.status, 'VALIDATED', null));
    }
    if (stmts.length) await this.db.batch(stmts);
  }

  async schedulePublications({ batchId, version, publishAt, now }) {
    const pubs = await this.listPublications(batchId, version);
    const status = Date.parse(publishAt) <= Date.parse(now) ? 'READY' : 'SCHEDULED';
    const stmts = [];
    for (const p of pubs) {
      if (!['VALIDATED', 'READY', 'SCHEDULED'].includes(p.status)) continue;
      const post = { ...p.post, scheduled_at: publishAt };
      stmts.push(this.db.prepare(`UPDATE publications SET scheduled_at = ?, status = ?, post_json = ?, updated_at = ? WHERE publication_id = ? AND status = ?`)
        .bind(publishAt, status, j(post), now, p.publication_id, p.status));
      stmts.push(this.db.prepare('INSERT INTO publication_events (publication_id, batch_id, at, op, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(p.publication_id, batchId, now, 'SCHEDULED_AT', p.status, status, j({ scheduled_at: publishAt })));
    }
    if (stmts.length) await this.db.batch(stmts);
    return stmts.length / 2;
  }

  async invalidateBatchForChanges({ batchId, now }) {
    const batch = await this.getBatch(batchId);
    if (!batch) return;
    const pubs = await this.listPublications(batchId, batch.version);
    const stmts = [
      this.db.prepare(`UPDATE approvals SET valid = 0, invalidated_at = ?, invalidated_reason = ? WHERE batch_id = ? AND valid = 1`)
        .bind(now, 'Cambios pedidos desde el encargo', batchId),
    ];
    if (['APPROVED', 'READY_FOR_REVIEW'].includes(batch.status)) {
      stmts.push(this.db.prepare(`UPDATE batches SET status = 'CHANGES_REQUESTED', approved_at = NULL, approved_by = NULL, approved_version = NULL, approved_hash = NULL, updated_at = ? WHERE batch_id = ?`)
        .bind(now, batchId));
    }
    for (const p of pubs) {
      if (!['READY', 'SCHEDULED'].includes(p.status)) continue;
      stmts.push(this.db.prepare(`UPDATE publications SET status = 'VALIDATED', updated_at = ? WHERE publication_id = ? AND status = ?`).bind(now, p.publication_id, p.status));
      stmts.push(this.db.prepare('INSERT INTO publication_events (publication_id, batch_id, at, op, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(p.publication_id, batchId, now, 'DECISION_REQUEST_CHANGES', p.status, 'VALIDATED', null));
    }
    await this.db.batch(stmts);
  }

  async cancelLinkedBatch({ batchId, now }) {
    const batch = await this.getBatch(batchId);
    if (!batch) return;
    const pubs = await this.listPublications(batchId, batch.version);
    const stmts = [
      this.db.prepare(`UPDATE approvals SET valid = 0, invalidated_at = ?, invalidated_reason = ? WHERE batch_id = ? AND valid = 1`)
        .bind(now, 'Encargo cancelado', batchId),
    ];
    if (['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'CHANGES_REQUESTED'].includes(batch.status)) {
      stmts.push(this.db.prepare(`UPDATE batches SET status = 'REJECTED', approved_at = NULL, approved_by = NULL, approved_version = NULL, approved_hash = NULL, updated_at = ? WHERE batch_id = ?`)
        .bind(now, batchId));
    }
    for (const p of pubs) {
      if (['PUBLISHED', 'CANCELLED'].includes(p.status)) continue;
      stmts.push(this.db.prepare(`UPDATE publications SET status = 'CANCELLED', updated_at = ? WHERE publication_id = ? AND status = ?`).bind(now, p.publication_id, p.status));
      stmts.push(this.db.prepare('INSERT INTO publication_events (publication_id, batch_id, at, op, from_status, to_status, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(p.publication_id, batchId, now, 'CANCELLED', p.status, 'CANCELLED', null));
    }
    await this.db.batch(stmts);
  }

  async settleAssetDeletes({ gone, failed, userId, bytes }) {
    const stmts = [];
    for (const row of gone) stmts.push(this.db.prepare('DELETE FROM encargo_assets WHERE asset_id = ?').bind(row.asset_id));
    for (const row of failed) stmts.push(this.db.prepare('UPDATE encargo_assets SET delete_pending = 1 WHERE asset_id = ?').bind(row.asset_id));
    if (bytes) stmts.push(...byteRelease(this.db, userId, bytes));
    if (stmts.length) await this.db.batch(stmts);
  }

  async listPendingDeletes(limit) {
    const r = await this.db.prepare(`SELECT s.*, a.user_id
      FROM encargo_assets s
      JOIN encargos e ON e.encargo_id = s.encargo_id
      JOIN accounts a ON a.account_id = e.account_id
      WHERE s.delete_pending = 1
      ORDER BY s.created_at
      LIMIT ?`).bind(limit).all();
    return r.results;
  }

  async reserveBytes(userId, bytes, userCap, globalCap) {
    await this.db.batch([
      this.db.prepare(`INSERT INTO r2_bytes (scope, bytes_stored) VALUES ('global', 0) ON CONFLICT(scope) DO NOTHING`),
      this.db.prepare(`INSERT INTO r2_bytes (scope, bytes_stored) VALUES (?, 0) ON CONFLICT(scope) DO NOTHING`).bind(userId),
    ]);
    const user = await this.db.prepare(`UPDATE r2_bytes SET bytes_stored = bytes_stored + ? WHERE scope = ? AND bytes_stored + ? <= ?`)
      .bind(bytes, userId, bytes, userCap).run();
    if (user.meta.changes !== 1) return false;
    const global = await this.db.prepare(`UPDATE r2_bytes SET bytes_stored = bytes_stored + ? WHERE scope = 'global' AND bytes_stored + ? <= ?`)
      .bind(bytes, bytes, globalCap).run();
    if (global.meta.changes !== 1) {
      await this.db.prepare(`UPDATE r2_bytes SET bytes_stored = bytes_stored - ? WHERE scope = ? AND bytes_stored >= ?`).bind(bytes, userId, bytes).run();
      return false;
    }
    return true;
  }

  async releaseBytes(userId, bytes) {
    if (!bytes) return;
    await this.db.batch(byteRelease(this.db, userId, bytes));
  }

  async noteBytesPeak(userId, now) {
    const day = now.slice(0, 10);
    await this.ensureDaily(userId, day);
    const globalBytes = await this.storedBytes('global');
    const userBytes = await this.storedBytes(userId);
    await this.db.batch([
      this.db.prepare('UPDATE r2_daily SET bytes_peak = MAX(bytes_peak, ?) WHERE scope = ? AND day = ?').bind(globalBytes, 'global', day),
      this.db.prepare('UPDATE r2_daily SET bytes_peak = MAX(bytes_peak, ?) WHERE scope = ? AND day = ?').bind(userBytes, userId, day),
    ]);
  }

  async classUsed(scope, kind, since) {
    const sql = kind === 'b'
      ? 'SELECT COALESCE(SUM(class_b), 0) AS n FROM r2_daily WHERE scope = ? AND day >= ?'
      : 'SELECT COALESCE(SUM(class_a), 0) AS n FROM r2_daily WHERE scope = ? AND day >= ?';
    const row = await this.db.prepare(sql).bind(scope, since).first();
    return Number(row?.n ?? 0);
  }

  async reserveDaily(userId, kind, now, userCap, globalCap) {
    const day = now.slice(0, 10);
    const since = shiftUtcDay(day, -29);
    await this.ensureDaily(userId, day);
    if (!await this.bumpDaily(userId, day, since, kind, userCap)) return false;
    if (!await this.bumpDaily('global', day, since, kind, globalCap)) {
      await this.unbumpDaily(userId, day, kind);
      return false;
    }
    return true;
  }

  async releaseDaily(userId, kind, now) {
    const day = now.slice(0, 10);
    await this.db.batch([
      this.unbumpStatement(userId, day, kind),
      this.unbumpStatement('global', day, kind),
    ]);
  }

  async ensureDaily(userId, day) {
    await this.db.batch([
      this.db.prepare(`INSERT INTO r2_daily (scope, day, class_a, class_b, bytes_peak) VALUES ('global', ?, 0, 0, 0) ON CONFLICT(scope, day) DO NOTHING`).bind(day),
      this.db.prepare(`INSERT INTO r2_daily (scope, day, class_a, class_b, bytes_peak) VALUES (?, ?, 0, 0, 0) ON CONFLICT(scope, day) DO NOTHING`).bind(userId, day),
    ]);
  }

  bumpDaily(scope, day, since, kind, cap) {
    const sql = kind === 'b'
      ? `UPDATE r2_daily SET class_b = class_b + 1 WHERE scope = ? AND day = ? AND (SELECT COALESCE(SUM(class_b), 0) FROM r2_daily WHERE scope = ? AND day >= ?) < ?`
      : `UPDATE r2_daily SET class_a = class_a + 1 WHERE scope = ? AND day = ? AND (SELECT COALESCE(SUM(class_a), 0) FROM r2_daily WHERE scope = ? AND day >= ?) < ?`;
    return this.db.prepare(sql).bind(scope, day, scope, since, cap).run().then((res) => res.meta.changes === 1);
  }

  unbumpStatement(scope, day, kind) {
    const sql = kind === 'b'
      ? 'UPDATE r2_daily SET class_b = class_b - 1 WHERE scope = ? AND day = ? AND class_b > 0'
      : 'UPDATE r2_daily SET class_a = class_a - 1 WHERE scope = ? AND day = ? AND class_a > 0';
    return this.db.prepare(sql).bind(scope, day);
  }

  unbumpDaily(scope, day, kind) {
    return this.unbumpStatement(scope, day, kind).run();
  }

  async openUploadForEncargo(encargoId) {
    return this.db.prepare(`SELECT upload_id FROM upload_sessions WHERE encargo_id = ? AND completed_at IS NULL`).bind(encargoId).first();
  }

  async uploadForUser(userId, uploadId) {
    return this.db.prepare('SELECT * FROM upload_sessions WHERE upload_id = ? AND user_id = ?').bind(uploadId, userId).first();
  }

  async insertUploadSession({ uploadId, userId, encargoId, sizeBytes, mime, expectedParts, fileSha, bytesReserved, now }) {
    await this.db.prepare(`INSERT INTO upload_sessions
      (upload_id, user_id, encargo_id, expected_parts, received_parts, file_sha256, part_hashes_json, size_bytes, mime, bytes_reserved, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, '{}', ?, ?, ?, ?, ?)`).bind(uploadId, userId, encargoId, expectedParts, fileSha, sizeBytes, mime, bytesReserved, now, now).run();
  }

  async addReserved(uploadId, delta, now) {
    if (delta >= 0) {
      await this.db.prepare('UPDATE upload_sessions SET bytes_reserved = bytes_reserved + ?, updated_at = ? WHERE upload_id = ?').bind(delta, now, uploadId).run();
      return;
    }
    const amount = -delta;
    await this.db.prepare('UPDATE upload_sessions SET bytes_reserved = bytes_reserved - ?, updated_at = ? WHERE upload_id = ? AND bytes_reserved >= ?')
      .bind(amount, now, uploadId, amount).run();
  }

  async releasePartHold(uploadId, userId, amount, now) {
    await this.db.batch([
      this.db.prepare('UPDATE upload_sessions SET bytes_reserved = bytes_reserved - ?, updated_at = ? WHERE upload_id = ? AND bytes_reserved >= ?')
        .bind(amount, now, uploadId, amount),
      ...byteRelease(this.db, userId, amount),
    ]);
  }

  async recordPart(uploadId, part, info, now) {
    const row = await this.db.prepare('SELECT part_hashes_json FROM upload_sessions WHERE upload_id = ?').bind(uploadId).first();
    const parts = JSON.parse(row?.part_hashes_json || '{}');
    const key = String(part);
    if (parts[key]) return parts[key].sha256 === info.sha256 ? 'same' : 'conflict';
    parts[key] = info;
    const received = Object.keys(parts).length;
    const res = await this.db.prepare(`UPDATE upload_sessions SET part_hashes_json = ?, received_parts = ?, updated_at = ? WHERE upload_id = ? AND part_hashes_json = ?`)
      .bind(JSON.stringify(parts), received, now, uploadId, row.part_hashes_json).run();
    return res.meta.changes === 1 ? 'saved' : 'retry';
  }

  async markUploadComplete({ uploadId, fileSha, now }) {
    const res = await this.db.prepare(`UPDATE upload_sessions
      SET completed_at = ?, file_sha256 = ?, bytes_reserved = 0, updated_at = ?
      WHERE upload_id = ? AND completed_at IS NULL AND received_parts = expected_parts`)
      .bind(now, fileSha, now, uploadId).run();
    return res.meta.changes === 1;
  }

  async linkSourceParts({ encargoId, mime, parts, now }) {
    const stmts = parts.map((part) => this.db.prepare(`INSERT INTO encargo_assets
      (asset_id, encargo_id, role, r2_key, sha256, mime, size_bytes, version, created_at)
      VALUES (?, ?, 'source', ?, ?, ?, ?, 1, ?)`).bind(crypto.randomUUID(), encargoId, part.key, part.sha256, mime, part.size, now));
    stmts.push(this.db.prepare(`UPDATE encargos SET status = 'queued', updated_at = ? WHERE encargo_id = ? AND status = 'draft'`).bind(now, encargoId));
    await this.db.batch(stmts);
  }

  async listOrphanUploads(cutoff, limit) {
    const r = await this.db.prepare(`SELECT * FROM upload_sessions WHERE completed_at IS NULL AND created_at < ? ORDER BY created_at LIMIT ?`).bind(cutoff, limit).all();
    return r.results;
  }

  async dropOrphanUpload(session) {
    const stmts = [
      this.db.prepare('DELETE FROM upload_sessions WHERE upload_id = ? AND completed_at IS NULL').bind(session.upload_id),
    ];
    if (Number(session.bytes_reserved) > 0) stmts.push(...byteRelease(this.db, session.user_id, Number(session.bytes_reserved)));
    await this.db.batch(stmts);
  }

  async insertDeliverableReservation(row) {
    await this.db.prepare(`INSERT INTO deliverable_reservations (
      reservation_id, encargo_id, user_id, r2_key, version, sha256, content_md5, mime, size_bytes,
      bytes_held, class_a_held, quota_day, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      row.reservationId, row.encargoId, row.userId, row.r2Key, row.version, row.sha256, row.contentMd5, row.mime,
      row.sizeBytes, row.bytesHeld, row.classAHeld, row.quotaDay, row.expiresAt, row.now,
    ).run();
  }

  async listOpenReservations(encargoId) {
    const r = await this.db.prepare(`SELECT * FROM deliverable_reservations
      WHERE encargo_id = ? AND consumed_at IS NULL AND released_at IS NULL
      ORDER BY created_at`).bind(encargoId).all();
    return r.results;
  }

  async reservationForEncargo(encargoId, r2Key) {
    return this.db.prepare(`SELECT * FROM deliverable_reservations WHERE encargo_id = ? AND r2_key = ?`).bind(encargoId, r2Key).first();
  }

  async listExpiredReservations(now, limit) {
    const r = await this.db.prepare(`SELECT * FROM deliverable_reservations
      WHERE consumed_at IS NULL AND released_at IS NULL AND expires_at <= ?
      ORDER BY expires_at LIMIT ?`).bind(now, limit).all();
    return r.results;
  }

  async markReservationReleased(reservationId, now) {
    const r = await this.db.prepare(`UPDATE deliverable_reservations
      SET released_at = ?, bytes_held = 0, class_a_held = 0
      WHERE reservation_id = ? AND consumed_at IS NULL AND released_at IS NULL`).bind(now, reservationId).run();
    return r.meta.changes === 1;
  }

  async markReservationConsumed(reservationId, now) {
    const r = await this.db.prepare(`UPDATE deliverable_reservations
      SET consumed_at = ?
      WHERE reservation_id = ? AND consumed_at IS NULL AND released_at IS NULL`).bind(now, reservationId).run();
    return r.meta.changes === 1;
  }

  async reopenReservation(reservationId, consumedAt) {
    const r = await this.db.prepare(`UPDATE deliverable_reservations
      SET consumed_at = NULL
      WHERE reservation_id = ? AND consumed_at = ? AND released_at IS NULL`).bind(reservationId, consumedAt).run();
    return r.meta.changes === 1;
  }
}

function byteRelease(db, userId, bytes) {
  return [
    db.prepare(`UPDATE r2_bytes SET bytes_stored = bytes_stored - ? WHERE scope = 'global' AND bytes_stored >= ?`).bind(bytes, bytes),
    db.prepare('UPDATE r2_bytes SET bytes_stored = bytes_stored - ? WHERE scope = ? AND bytes_stored >= ?').bind(bytes, userId, bytes),
  ];
}

function parseEncargo(row) {
  return { ...row, platforms: JSON.parse(row.platforms_json), synthetic: row.synthetic === null || row.synthetic === undefined ? null : row.synthetic === 1 };
}

function parsePub(r) {
  return { ...r, post: JSON.parse(r.post_json), errors: JSON.parse(r.errors_json || '[]'), post_json: undefined, errors_json: undefined };
}

export { PS };
