import './offline-network.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = new URL('../', import.meta.url);
test('checks execute on the pinned current LTS and package manager with installed exact dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const mise = await readFile(new URL('mise.toml', root), 'utf8');
  const nodePin = /node = "([^"]+)"/.exec(mise)?.[1];
  assert.equal(
    process.versions.node,
    nodePin,
    'Run checks with the pinned Node LTS',
  );
  const pnpm = (
    await promisify(execFile)('pnpm', ['--version'], { timeout: 10000 })
  ).stdout.trim();
  assert.equal(
    `pnpm@${pnpm}`,
    pkg.packageManager,
    'Run checks with pinned pnpm',
  );
  for (const [name, declared] of Object.entries(pkg.devDependencies)) {
    const expected = declared.startsWith('npm:')
      ? declared.slice(declared.lastIndexOf('@') + 1)
      : declared;
    const installed = JSON.parse(
      await readFile(
        new URL(`node_modules/${name}/package.json`, root),
        'utf8',
      ),
    );
    assert.equal(
      installed.version,
      expected,
      `${name} must use its exact reviewed version`,
    );
  }
});
