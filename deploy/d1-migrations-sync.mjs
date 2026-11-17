#!/usr/bin/env node
/**
 * Marca 0001–0003 como aplicadas en d1_migrations si el esquema ya existe (migración manual previa).
 * Idempotente: seguro ejecutar antes de `wrangler d1 migrations apply --remote`.
 *
 * Uso:
 *   node deploy/d1-migrations-sync.mjs              # imprime SQL por stdout
 *   node deploy/d1-migrations-sync.mjs --write      # escribe deploy/out/d1-migrations-sync.sql
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'deploy/out');

/** @type {{ name: string, table: string }[]} */
const CHECKS = [
  { name: '0001_init.sql', table: 'batches' },
  { name: '0002_media_index.sql', table: 'media_objects' },
  { name: '0003_rate_limits.sql', table: 'http_rate_windows' },
];

const sql = [
  `CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`,
  ...CHECKS.map(
    ({ name, table }) => `INSERT INTO d1_migrations (name)
SELECT '${name.replace(/'/g, "''")}'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${table.replace(/'/g, "''")}')
  AND NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '${name.replace(/'/g, "''")}');`,
  ),
].join('\n');

if (process.argv.includes('--write')) {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, 'd1-migrations-sync.sql');
  writeFileSync(path, `${sql}\n`);
  console.log(path);
} else {
  process.stdout.write(`${sql}\n`);
}