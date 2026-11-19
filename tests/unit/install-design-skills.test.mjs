import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptSource = await readFile(new URL('../../scripts/install-design-skills.sh', import.meta.url), 'utf8');
const lock = '{"version":2,"skills":{}}\n';

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'design-skills-'));
  await mkdir(join(dir, 'scripts'));
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'scripts', 'install-design-skills.sh'), scriptSource, { mode: 0o755 });
  await writeFile(join(dir, 'skills-lock.json'), lock);
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: dir });
  await execFileAsync('git', ['add', 'skills-lock.json'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'lock'], { cwd: dir });
  return dir;
}

function npxStub(dir, mode) {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/npx.log"
if [ "${mode}" = "fail" ]; then
  exit 1
fi
skill=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--skill" ]; then
    skill="$arg"
  fi
  prev="$arg"
done
if [ "${mode}" = "skip-file" ]; then
  exit 0
fi
mkdir -p "${dir}/.agents/skills/$skill"
printf '%s\\n' "name: $skill" > "${dir}/.agents/skills/$skill/SKILL.md"
printf '%s\\n' '{"dirty":true}' > "${dir}/skills-lock.json"
`;
}

async function run(dir, { mode, pathPrefix } = {}) {
  if (mode) {
    await writeFile(join(dir, 'bin', 'npx'), npxStub(dir, mode), { mode: 0o755 });
  }
  const path = pathPrefix ?? `${join(dir, 'bin')}:/usr/bin:/bin`;
  try {
    const result = await execFileAsync('bash', ['scripts/install-design-skills.sh'], {
      cwd: dir,
      env: { ...process.env, PATH: path },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('copia las dos skills, exige --copy y restaura skills-lock.json', async () => {
  const dir = await repo();
  try {
    const result = await run(dir, { mode: 'ok' });
    assert.equal(result.code, 0, result.stderr);
    const log = await readFile(join(dir, 'npx.log'), 'utf8');
    assert.match(log, /--skill design-taste-frontend --copy/);
    assert.match(log, /--skill high-end-visual-design --copy/);
    assert.equal(await readFile(join(dir, '.agents/skills/design-taste-frontend/SKILL.md'), 'utf8'), 'name: design-taste-frontend\n');
    assert.equal(await readFile(join(dir, '.agents/skills/high-end-visual-design/SKILL.md'), 'utf8'), 'name: high-end-visual-design\n');
    assert.equal(await readFile(join(dir, 'skills-lock.json'), 'utf8'), lock);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no llama a npx si las dos SKILL.md ya existen', async () => {
  const dir = await repo();
  try {
    for (const name of ['design-taste-frontend', 'high-end-visual-design']) {
      await mkdir(join(dir, '.agents/skills', name), { recursive: true });
      await writeFile(join(dir, '.agents/skills', name, 'SKILL.md'), 'ya\n');
    }
    const result = await run(dir, { pathPrefix: '/usr/bin:/bin' });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(join(dir, 'npx.log'), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('falla si npx no está o no deja SKILL.md', async () => {
  const missing = await repo();
  const empty = await repo();
  const failed = await repo();
  try {
    const noNpx = await run(missing, { pathPrefix: '/usr/bin:/bin' });
    assert.equal(noNpx.code, 1);
    assert.match(noNpx.stderr, /npx no disponible/);

    const noFile = await run(empty, { mode: 'skip-file' });
    assert.equal(noFile.code, 1);
    assert.match(noFile.stderr, /falta \.agents\/skills\/design-taste-frontend\/SKILL\.md/);

    const npxFail = await run(failed, { mode: 'fail' });
    assert.notEqual(npxFail.code, 0);
  } finally {
    await rm(missing, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
    await rm(failed, { recursive: true, force: true });
  }
});
