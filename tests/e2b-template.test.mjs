import './offline-network.mjs';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after, before } from 'node:test';
import { Template } from 'e2b';
import { parse } from 'yaml';
import {
  buildTemplate,
  createTemplate,
  MISE_SHA256,
  parseBuildArguments,
  TEMPLATE_FILES,
  TOOL_VERSIONS,
  TOOLCHAIN_ROOT,
} from '../recipes/02-e2b-development/template.mjs';
import {
  PNPM_VERSION,
  resolvePinnedPnpm,
} from '../recipes/02-e2b-development/template-tools/resolve-pnpm.mjs';

const recipe = new URL('../recipes/02-e2b-development/', import.meta.url);
const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async () => {
    throw new Error('Network access is forbidden in offline template tests.');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
});

test('E2B SDK serializes the pinned template without a network request or start command', async () => {
  const definition = JSON.parse(await Template.toJSON(createTemplate()));
  assert.equal(definition.fromTemplate, 'pi');
  assert.equal(definition.startCmd, undefined);
  assert.equal(definition.readyCmd, undefined);
  assert.deepEqual(
    definition.steps
      .filter((step) => step.type === 'COPY')
      .map((step) => step.args.slice(0, 2)),
    TEMPLATE_FILES,
  );
  assert.equal(TEMPLATE_FILES.length, 8);
  assert.deepEqual(
    definition.steps
      .filter((step) => step.type === 'USER')
      .map((step) => step.args[0]),
    ['root', 'user'],
  );
  assert(!JSON.stringify(definition).includes('E2B_API_KEY'));
  assert(!JSON.stringify(definition).includes('GHAI_API_KEY'));
  assert(
    !definition.steps.some((step) =>
      step.args.some((arg) => arg.includes('pi -p')),
    ),
  );
  const envArgs = definition.steps.find((step) => step.type === 'ENV').args;
  assert.equal(
    envArgs[envArgs.indexOf('PATH') + 1].split(':')[0],
    `${TOOLCHAIN_ROOT}/bin`,
  );
});

test('template pins agree with root dependencies and official Linux-only mise locks', async () => {
  const root = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(root.packageManager, `pnpm@${TOOL_VERSIONS.pnpm}`);
  assert.equal(
    root.devDependencies['@earendil-works/pi-coding-agent'],
    TOOL_VERSIONS.pi,
  );
  assert.equal(root.devDependencies.e2b, '2.55.0');
  const manifest = await readFile(
    new URL('template-tools/mise.toml', recipe),
    'utf8',
  );
  assert(manifest.includes(`"core:node" = "${TOOL_VERSIONS.node}"`));
  assert(
    manifest.includes(
      `"npm:pnpm" = { version = "${TOOL_VERSIONS.pnpm}", allow_builds = false }`,
    ),
  );
  assert.equal(PNPM_VERSION, TOOL_VERSIONS.pnpm);
  const lock = await readFile(
    new URL('template-tools/mise.lock', recipe),
    'utf8',
  );
  assert(lock.includes('platforms.linux-x64'));
  assert(!lock.includes('macos'));
  assert(
    lock.includes(
      'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz',
    ),
  );
  assert.match(lock, /checksum = "sha256:[0-9a-f]{64}"/);
  assert.match(lock, /digest = "sha256:[0-9a-f]{64}"/);
  const pnpm = parse(
    await readFile(
      new URL(
        'template-tools/.mise/locks/npm-pnpm/12.11.2/aube-lock.yaml',
        recipe,
      ),
      'utf8',
    ),
  );
  assert.equal(
    pnpm.importers['.'].dependencies.pnpm.version,
    TOOL_VERSIONS.pnpm,
  );
  assert.match(pnpm.packages['pnpm@12.11.2'].resolution.integrity, /^sha512-/);
  assert.match(
    pnpm.packages['@pnpm/exe.linux-x64@12.11.2'].resolution.integrity,
    /^sha512-/,
  );
  assert.equal(
    pnpm.snapshots['pnpm@12.11.2'].optionalDependencies['@pnpm/exe.linux-x64'],
    TOOL_VERSIONS.pnpm,
  );
});

test('pnpm resolver uses only the locked native optional dependency, never fallback scripts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghai-pnpm-resolver-'));
  const install = join(directory, 'install');
  const wrapper = join(install, 'node_modules/pnpm');
  const native = join(install, 'node_modules/@pnpm/exe.linux-x64');
  const manifest = { name: '@pnpm/exe.linux-x64', version: PNPM_VERSION };
  try {
    await mkdir(wrapper, { recursive: true });
    await mkdir(native, { recursive: true });
    await writeFile(
      join(wrapper, 'package.json'),
      JSON.stringify({
        name: 'pnpm',
        version: PNPM_VERSION,
        optionalDependencies: { '@pnpm/exe.linux-x64': PNPM_VERSION },
      }),
    );
    await writeFile(join(native, 'package.json'), JSON.stringify(manifest));
    const binary = join(native, 'pnpm');
    await writeFile(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), {
      mode: 0o700,
    });
    assert.equal(resolvePinnedPnpm(install), binary);
    await writeFile(
      join(native, 'package.json'),
      JSON.stringify({ ...manifest, version: '0.0.0' }),
    );
    assert.throws(
      () => resolvePinnedPnpm(install),
      /Unexpected pnpm native package/,
    );
    await writeFile(join(native, 'package.json'), JSON.stringify(manifest));
    await writeFile(binary, '#!/bin/sh\necho unexpected wrapper\n');
    assert.throws(() => resolvePinnedPnpm(install), /not an ELF binary/);
    await writeFile(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    await chmod(binary, 0o600);
    assert.throws(() => resolvePinnedPnpm(install), /not executable/);
    await rm(binary);
    const outside = join(directory, 'outside-pnpm');
    await writeFile(outside, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), {
      mode: 0o700,
    });
    await symlink(outside, binary);
    assert.throws(
      () => resolvePinnedPnpm(install),
      /inside its locked installation/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bootstrap has explicit sandbox guard, fixed checksum and locked script-free installs', async () => {
  const bootstrapPath = new URL('template-tools/bootstrap.sh', recipe);
  const bootstrap = await readFile(bootstrapPath, 'utf8');
  assert(bootstrap.includes(MISE_SHA256));
  assert(bootstrap.includes('sha256sum -c -'));
  assert(bootstrap.includes('mise" install --locked'));
  assert(bootstrap.includes('pnpm install --frozen-lockfile --ignore-scripts'));
  assert(bootstrap.includes('env -i'));
  assert(bootstrap.includes('node "$root/template-tools/resolve-pnpm.mjs"'));
  assert(!bootstrap.includes('mise" which pnpm'));
  assert(!bootstrap.includes('NPM_CONFIG_USERCONFIG=/dev/null'));
  assert(!bootstrap.includes('curl |'));
  assert(!bootstrap.includes('mise use --global'));
  assert.equal(spawnSync('bash', ['-n', bootstrapPath.pathname]).status, 0);
  const result = spawnSync('bash', [bootstrapPath.pathname], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to install outside/);
});

test('template build fails before credential lookup unless explicitly opted in', async () => {
  const inaccessibleEnvironment = new Proxy(
    {},
    {
      get() {
        throw new Error('credential lookup');
      },
    },
  );
  await assert.rejects(
    buildTemplate([], inaccessibleEnvironment),
    /require explicit --live/,
  );
  assert.throws(
    () =>
      parseBuildArguments([
        '--live',
        '--name',
        'bad;command',
        '--api-key-env',
        'E2B_API_KEY',
      ]),
    /--name/,
  );
  assert.throws(
    () => parseBuildArguments(['--live', '--name', 'ghai-test']),
    /--api-key-env/,
  );
  assert.throws(
    () =>
      parseBuildArguments([
        '--live',
        '--name',
        'ghai-test',
        '--api-key-env',
        'invalid-name',
      ]),
    /--api-key-env/,
  );
  assert.throws(
    () =>
      parseBuildArguments([
        '--live',
        '--name',
        'ghai-test',
        '--api-key-env',
        'E2B_API_KEY',
        '--unknown',
      ]),
    /Unknown option/,
  );
});

test('mocked build persists immutable IDs, hashes, endpoint pin and create-only reservation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghai-template-test-'));
  const output = join(directory, 'build.json');
  let calls = 0;
  try {
    const buildOperation = async (template, name, options) => {
      calls++;
      assert.equal(name, 'ghai-test');
      assert.equal(options.apiKey, 'fixture-credential-never-persist');
      assert.equal(options.apiUrl, 'https://api.e2b.app');
      assert.equal(options.domain, 'e2b.app');
      assert.equal(options.retries, 0);
      assert.equal(options.debug, false);
      const reservation = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(reservation.status, 'build-outcome-unknown');
      assert.equal(reservation.buildId, null);
      assert.equal(
        JSON.parse(await Template.toJSON(template)).fromTemplate,
        'pi',
      );
      return {
        templateId: 'fixture-template-id',
        buildId: 'fixture-immutable-build-id',
      };
    };
    const args = [
      '--live',
      '--name',
      'ghai-test',
      '--api-key-env',
      'TEST_E2B_KEY',
      '--out',
      output,
    ];
    const environment = {
      TEST_E2B_KEY: 'fixture-credential-never-persist',
      E2B_API_URL: 'https://untrusted.invalid',
    };
    const descriptor = await buildTemplate(args, environment, buildOperation);
    assert.equal(descriptor.status, 'ready');
    assert.equal(descriptor.buildId, 'fixture-immutable-build-id');
    assert.equal(descriptor.baseIsMutable, true);
    assert.equal(descriptor.baseBuildId, null);
    assert.equal(Object.keys(descriptor.sourceSha256).length, 8);
    assert(
      Object.values(descriptor.sourceSha256).every((hash) =>
        /^[0-9a-f]{64}$/.test(hash),
      ),
    );
    const saved = await readFile(output, 'utf8');
    assert.deepEqual(JSON.parse(saved), descriptor);
    assert(!saved.includes('fixture-credential-never-persist'));
    await assert.rejects(buildTemplate(args, environment, buildOperation), {
      code: 'EEXIST',
    });
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('mocked unknown build preserves its reservation and does not disclose raw errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghai-template-test-'));
  const output = join(directory, 'build.json');
  let calls = 0;
  try {
    const buildOperation = async () => {
      calls++;
      throw new Error('raw SDK error includes fixture-secret');
    };
    const args = [
      '--live',
      '--name',
      'ghai-test',
      '--api-key-env',
      'TEST_E2B_KEY',
      '--out',
      output,
    ];
    const environment = { TEST_E2B_KEY: 'fixture-secret' };
    await assert.rejects(
      buildTemplate(args, environment, buildOperation),
      /did not return a verified success/,
    );
    const saved = await readFile(output, 'utf8');
    assert.equal(JSON.parse(saved).status, 'build-outcome-unknown');
    assert(!saved.includes('fixture-secret'));
    await assert.rejects(buildTemplate(args, environment, buildOperation), {
      code: 'EEXIST',
    });
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
