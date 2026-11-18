#!/usr/bin/env node
/**
 * Lee la salida de `wrangler preview --json` y escribe preview_url= para GITHUB_OUTPUT.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function previewUrlFromWranglerOutput(text) {
  let index = text.length;
  while (index > 0) {
    index = text.lastIndexOf('{', index - 1);
    if (index < 0) break;
    try {
      const parsed = JSON.parse(text.slice(index));
      const url = parsed.preview?.urls?.[0] ?? parsed.preview_urls?.[0];
      if (typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url)) return url;
    } catch {
      // El '{' anterior no abre el JSON de wrangler.
    }
  }
  throw new Error('wrangler preview no devolvió una URL https');
}

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Falta el fichero de salida de wrangler preview');
  const url = previewUrlFromWranglerOutput(readFileSync(file, 'utf8'));
  process.stdout.write(`preview_url=${url}\n`);
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
