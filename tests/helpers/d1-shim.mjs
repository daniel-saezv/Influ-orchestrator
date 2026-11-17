// Doble de prueba de D1 sobre node:sqlite (solo para tests locales; producción usa D1 real).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.params); return { meta: { changes: Number(r.changes) } }; }
  _exec() {
    const st = this.db.prepare(this.sql);
    if (/^\s*select/i.test(this.sql)) return { results: st.all(...this.params), meta: { changes: 0 } };
    const r = st.run(...this.params); return { results: [], meta: { changes: Number(r.changes) } };
  }
}

export function createD1Shim(migrationPath) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(migrationPath, 'utf8'));
  return {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    _raw: db,
  };
}

export function createKvShim() {
  const m = new Map();
  return {
    async put(k, v, { metadata } = {}) { m.set(k, { v: new Uint8Array(v), metadata }); },
    async getWithMetadata(k) { const e = m.get(k); return e ? { value: e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.byteLength), metadata: e.metadata } : { value: null, metadata: null }; },
    async list({ prefix }) { return { keys: [...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })) }; },
  };
}
