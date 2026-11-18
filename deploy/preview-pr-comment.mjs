#!/usr/bin/env node
/**
 * Crea o actualiza un único comentario de preview en la PR.
 * Env: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, PREVIEW_URL, HEAD_SHA
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const PREVIEW_COMMENT_MARKER = '<!-- influ-preview -->';

export function previewCommentBody({ url, sha }) {
  if (!/^https:\/\/[^\s]+$/.test(url)) throw new Error('URL de preview inválida');
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('SHA de cabeza inválido');
  return [
    PREVIEW_COMMENT_MARKER,
    '**Preview de esta PR**',
    '',
    `- URL: ${url}`,
    `- SHA: \`${sha}\``,
    '- D1: `influ-poc-db-preview`',
    '',
    'Cada push actualiza este comentario. Las migraciones y el Worker de esta preview no tocan `influ-poc-db` ni el Worker de producción.',
    '',
  ].join('\n');
}

async function github(token, path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub ${path} HTTP ${response.status}: ${JSON.stringify(body.message ?? body)}`);
  }
  return body;
}

async function listComments(token, repository, prNumber) {
  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(
      token,
      `/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments.filter((comment) => comment.body?.includes(PREVIEW_COMMENT_MARKER));
}

export async function upsertPreviewComment({ token, repository, prNumber, url, sha }) {
  const body = previewCommentBody({ url, sha });
  const existing = await listComments(token, repository, prNumber);
  if (existing.length === 0) {
    await github(token, `/repos/${repository}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    return { action: 'created' };
  }
  await github(token, `/repos/${repository}/issues/comments/${existing[0].id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
  for (const extra of existing.slice(1)) {
    await github(token, `/repos/${repository}/issues/comments/${extra.id}`, { method: 'DELETE' });
  }
  return { action: 'updated', removed: existing.length - 1 };
}

async function main() {
  const token = process.env.GH_TOKEN?.trim();
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const prNumber = process.env.PR_NUMBER?.trim();
  const url = process.env.PREVIEW_URL?.trim();
  const sha = process.env.HEAD_SHA?.trim();
  if (!token || !repository || !prNumber || !url || !sha) {
    throw new Error('Faltan GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, PREVIEW_URL o HEAD_SHA');
  }
  const result = await upsertPreviewComment({ token, repository, prNumber, url, sha });
  console.log(`Comentario de preview ${result.action}`);
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
