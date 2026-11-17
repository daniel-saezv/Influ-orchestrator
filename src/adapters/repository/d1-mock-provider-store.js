// Almacén clave-valor del simulador sobre D1 (consistencia fuerte, a diferencia de KV).
// Con caché de lectura por invocación para ahorrar consultas (límite D1 del plan gratuito).
export class D1MockProviderStore {
  constructor(db) { this.db = db; this.cache = new Map(); }
  async get(k) {
    if (this.cache.has(k)) return structuredClone(this.cache.get(k));
    const row = await this.db.prepare('SELECT v FROM mock_provider_records WHERE k = ?').bind(k).first();
    const v = row ? JSON.parse(row.v) : null;
    this.cache.set(k, v);
    return v === null ? null : structuredClone(v);
  }
  async put(k, v) {
    const prev = this.cache.get(k);
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(v)) return;
    this.cache.set(k, structuredClone(v));
    await this.db.prepare('INSERT INTO mock_provider_records (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
      .bind(k, JSON.stringify(v), new Date().toISOString()).run();
  }
}

export class MemoryStore {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : null; }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
}
