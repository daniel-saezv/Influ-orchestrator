#!/usr/bin/env node
/**
 * Comprobaciones de seguridad antes de desplegar: PUBLISHER_MODE=mock y LIVE bloqueado en código.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
const configJs = readFileSync(join(ROOT, 'src/core/config.js'), 'utf8');

let failed = 0;

const modeMatch = toml.match(/^\s*PUBLISHER_MODE\s*=\s*"([^"]*)"/m);
const mode = modeMatch?.[1];
if (mode !== 'mock') {
  console.error(`::error::PUBLISHER_MODE en wrangler.toml debe ser "mock" (actual: ${mode ?? 'ausente'})`);
  failed++;
}

if (!/export const LIVE_ENABLED_IN_BUILD = false;/.test(configJs)) {
  console.error('::error::LIVE_ENABLED_IN_BUILD debe ser false en src/core/config.js');
  failed++;
}

if (failed) process.exit(1);
console.log('Guard de despliegue: PUBLISHER_MODE=mock y LIVE_ENABLED_IN_BUILD=false');