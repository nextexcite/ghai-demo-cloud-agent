import './offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planJob,
  loadJob,
  runJob,
  cancelJob,
  hash,
  writeJson,
  selectModel,
  piConfig,
  E2BAdapter,
  e2bOptions,
} from '../recipes/02-e2b-development/core.mjs';
import {
  validateOutputPath,
  scanSecrets,
  publishJob,
  GitHubPublisher,
} from '../recipes/02-e2b-development/publish.mjs';
import {
  createEventMonitor,
  piArguments,
} from '../recipes/02-e2b-development/remote-runner.mjs';
import {
  parseArgs,
  planDefaults,
  repositoryFromOrigin,
} from '../recipes/02-e2b-development/cli.mjs';
const model = {
  id: 'fixture-primary-model',
  name: 'GHAI preset',
  reasoning: true,
  input: ['text'],
  contextWindow: 65536,
  maxTokens: 8192,
  compat: { supportsStrictMode: false },
};
const config = {
  providers: {
    ghai: {
      baseUrl: 'https://gateway.example.invalid/v1',
      api: 'openai-responses',
      apiKey: 'DO-NOT-COPY',
      headers: { Secret: 'DO-NOT-COPY-EITHER' },
      models: [model],
    },
    other: { apiKey: 'OTHER-SECRET' },
  },
};
const env = {
  TEAM_E2B: 'e2b-only-canary',
  GHAI_API_KEY: 'ghai-runtime-canary',
  TEAM_DOCS: 'docs-runtime-canary',
  TEAM_GITHUB: 'github-publisher-canary',
};
const patch =
  'diff --git a/examples/todo-app/README.md b/examples/todo-app/README.md\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/examples/todo-app/README.md\n@@ -0,0 +1 @@\n+hello\n';
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'e2b-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelsFile = join(root, 'models.json');
  await writeFile(modelsFile, JSON.stringify(config));
  const dir = join(root, 'job');
  const options = {
    jobDir: dir,
    repository: 'nextexcite/ghai-demo-cloud-agent',
    baseSha: 'a'.repeat(40),
    modelsFile,
    model: model.id,
    baseUrl: config.providers.ghai.baseUrl,
    environment: {
      e2b: 'TEAM_E2B',
      ghai: 'GHAI_API_KEY',
      context7: 'TEAM_DOCS',
      github: 'TEAM_GITHUB',
    },
    ...overrides,
  };
  const job = await planJob(options);
  const buildFile = join(root, 'build.json');
  await writeFile(
    buildFile,
    JSON.stringify({
      templateId: 'fake-template',
      buildId: 'fake-build',
      status: 'ready',
      toolchain: {
        pi: '1.1.0',
        node: '24.21.0',
        pnpm: '12.11.2',
        mise: '2026.10.8',
        platform: 'linux-x64',
      },
      sdk: { version: '2.55.0' },
    }),
  );
  return { dir, root, modelsFile, job, options, buildFile };
}
function fakeAdapter(options = {}) {
  const calls = [];
  const sandbox = {
    sandboxId: 'fake-sandbox',
    files: {
      write: async (files) => {
        calls.push({ action: 'upload', files });
      },
      getInfo: async () => ({ size: options.patch?.length ?? patch.length }),
      read: async () => options.patch ?? patch,
    },
    commands: {
      run: async (command, settings) => {
        calls.push({ action: 'command', command, settings });
        if (options.failCommand && command.includes(options.failCommand))
          throw new Error('raw-secret-DO-NOT-STORE');
        let stdout = '';
        if (command.includes('rev-parse HEAD')) stdout = `${'a'.repeat(40)}\n`;
        if (command.includes('remote-runner.mjs'))
          stdout = JSON.stringify({
            status: options.agentFailure ? 'failed' : 'completed',
            observedTurns: 2,
            actualBillingUsd: null,
          });
        return { exitCode: 0, stdout, stderr: '' };
      },
    },
    kill: async () => {
      calls.push({ action: 'kill' });
      if (options.failKill) throw new Error('cleanup failure');
      return true;
    },
  };
  return {
    calls,
    async create(template, job, manifest) {
      calls.push({ action: 'create', template, job, manifest });
      if (options.failCreate) throw new Error('ambiguous-create');
      return sandbox;
    },
    async list() {
      return [{ sandboxId: 'fake-sandbox' }];
    },
    async kill(id) {
      calls.push({ action: 'kill-id', id });
      return true;
    },
  };
}
const noNetwork = async () => {};
test('plan freezes complete specs and selected preset without modifying local config', async (t) => {
  const f = await fixture(t);
  assert.equal(await readFile(f.modelsFile, 'utf8'), JSON.stringify(config));
  const loaded = await loadJob(f.dir);
  assert.deepEqual(loaded.job.model.compat, model.compat);
  assert.equal(JSON.stringify(loaded).includes('DO-NOT-COPY'), false);
  assert.equal(loaded.state.status, 'prepared');
  assert.deepEqual(loaded.job.allowedPaths, ['examples/todo-app/']);
});
test('plan refuses job directory reuse', async (t) => {
  const f = await fixture(t);
  await assert.rejects(planJob(f.options));
});
test('frozen spec edits invalidate handoff', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'product.md'), 'mutated');
  await assert.rejects(loadJob(f.dir), /Frozen input changed/);
});
test('changed job invalidates its reservation', async (t) => {
  const f = await fixture(t);
  const j = f.job;
  j.baseSha = 'b'.repeat(40);
  await writeJson(join(f.dir, 'job.json'), j);
  await assert.rejects(loadJob(f.dir), /Job changed/);
});
test('requires exact existing Responses model and literal metadata', () => {
  assert.throws(() =>
    selectModel(config, 'missing', config.providers.ghai.baseUrl),
  );
  assert.throws(() =>
    selectModel(
      {
        providers: {
          ghai: { ...config.providers.ghai, api: 'openai-completions' },
        },
      },
      model.id,
      config.providers.ghai.baseUrl,
    ),
  );
  assert.throws(() =>
    selectModel(
      {
        providers: {
          ghai: {
            ...config.providers.ghai,
            models: [{ ...model, name: '${SECRET}' }],
          },
        },
      },
      model.id,
      config.providers.ghai.baseUrl,
    ),
  );
});
test('no live flag means no network action', async (t) => {
  const f = await fixture(t);
  const adapter = fakeAdapter();
  await assert.rejects(
    runJob(f.dir, { adapter, env, buildFile: f.buildFile }),
    /--live/,
  );
  assert.equal(adapter.calls.length, 0);
});
test('missing runtime credential fails before provisioning', async (t) => {
  const f = await fixture(t);
  const adapter = fakeAdapter();
  await assert.rejects(
    runJob(f.dir, { live: true, adapter, env: {}, buildFile: f.buildFile }),
    /Missing environment variable/,
  );
  assert.equal(adapter.calls.length, 0);
});
test('unbuilt template fails closed before provisioning', async (t) => {
  const f = await fixture(t);
  await writeJson(f.buildFile, { templateId: null, buildId: null });
  const adapter = fakeAdapter();
  await assert.rejects(
    runJob(f.dir, { live: true, adapter, env, buildFile: f.buildFile }),
  );
  assert.equal(adapter.calls.length, 0);
});
test('fake E2B happy path verifies, collects, and kills without publishing', async (t) => {
  const f = await fixture(t);
  const adapter = fakeAdapter();
  const state = await runJob(f.dir, {
    live: true,
    adapter,
    env,
    buildFile: f.buildFile,
    verifyPublic: noNetwork,
  });
  assert.equal(state.status, 'ready_to_publish');
  assert.equal(state.cleanup, 'killed');
  assert.equal(adapter.calls[0].action, 'create');
  assert.equal(adapter.calls[0].template, 'fake-template:fake-build');
  assert.equal(adapter.calls.at(-1).action, 'kill');
  const runtime = adapter.calls.find((c) =>
    c.command?.includes('remote-runner.mjs'),
  );
  assert.deepEqual(runtime.settings.envs, {
    GHAI_API_KEY: env.GHAI_API_KEY,
    CONTEXT7_RUNTIME_KEY: env.TEAM_DOCS,
  });
  const remoteData = JSON.stringify(
    adapter.calls.filter((c) => ['command', 'upload'].includes(c.action)),
  );
  assert(!remoteData.includes(env.TEAM_E2B));
  assert(!remoteData.includes(env.TEAM_GITHUB));
  assert(!remoteData.includes('DO-NOT-COPY'));
  assert.equal((await loadJob(f.dir)).state.patchSha256, hash(patch));
});
test('spent jobs cannot create another sandbox', async (t) => {
  const f = await fixture(t);
  const adapter = fakeAdapter();
  await runJob(f.dir, {
    live: true,
    adapter,
    env,
    buildFile: f.buildFile,
    verifyPublic: noNetwork,
  });
  await assert.rejects(
    runJob(f.dir, {
      live: true,
      adapter,
      env,
      buildFile: f.buildFile,
      verifyPublic: noNetwork,
    }),
    /cannot be replayed/,
  );
  assert.equal(adapter.calls.filter((c) => c.action === 'create').length, 1);
});
for (const [name, options] of [
  ['agent failure', { agentFailure: true }],
  ['check failure', { failCommand: 'pnpm run test' }],
  ['credential in patch', { patch: patch + env.GHAI_API_KEY }],
]) {
  test(`${name} blocks publication and cleans up`, async (t) => {
    const f = await fixture(t);
    const adapter = fakeAdapter(options);
    const state = await runJob(f.dir, {
      live: true,
      adapter,
      env,
      buildFile: f.buildFile,
      verifyPublic: noNetwork,
    });
    assert.equal(state.status, 'failed');
    assert.equal(state.cleanup, 'killed');
    assert(!JSON.stringify(state).includes('raw-secret'));
  });
}
test('ambiguous create is reserved unknown and cannot replay', async (t) => {
  const f = await fixture(t);
  const adapter = fakeAdapter({ failCreate: true });
  const state = await runJob(f.dir, {
    live: true,
    adapter,
    env,
    buildFile: f.buildFile,
    verifyPublic: noNetwork,
  });
  assert.equal(state.status, 'unknown');
  await assert.rejects(
    runJob(f.dir, {
      live: true,
      adapter,
      env,
      buildFile: f.buildFile,
      verifyPublic: noNetwork,
    }),
  );
  const cancelled = await cancelJob(f.dir, { live: true, adapter, env });
  assert.equal(cancelled.cleanup, 'killed');
  assert.equal(cancelled.status, 'cancelled');
});
test('failed cleanup remains visibly unconfirmed', async (t) => {
  const f = await fixture(t);
  const state = await runJob(f.dir, {
    live: true,
    adapter: fakeAdapter({ failKill: true }),
    env,
    buildFile: f.buildFile,
    verifyPublic: noNetwork,
  });
  assert.equal(state.cleanup, 'unconfirmed');
});
test('native MCP exposes only Context7 documentation tools', async (t) => {
  const f = await fixture(t);
  const config = piConfig(f.job);
  assert.deepEqual(Object.keys(config['mcp.json'].mcpServers), ['context7']);
  const args = piArguments(f.job);
  assert.equal(
    args[args.indexOf('--tools') + 1],
    'read,bash,edit,write,grep,find,ls,mcp__context7__*',
  );
  assert(args.includes('--no-extensions'));
  assert(args.includes('builtin:mcp'));
  assert(args.includes('--no-context-files'));
  await assert.rejects(
    fixture(t, {
      environment: { ...f.options.environment, extra: 'EXTRA_KEY' },
    }),
    /Only the four/,
  );
});
test('event monitor requires settled stop and uses LF framing', () => {
  const monitor = createEventMonitor(2);
  const text = JSON.stringify({
    type: 'message_update',
    text: 'first\u2028second',
  });
  monitor.write(
    Buffer.from(
      `{"type":"turn_start"}\n${text}\n{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}\n{"type":"agent_settled","aborted":false}\n`,
    ),
  );
  assert.equal(monitor.finish().observedTurns, 1);
  assert.throws(() => createEventMonitor(2).finish());
  const exceeded = createEventMonitor(1);
  assert.throws(() =>
    exceeded.write(
      Buffer.from('{"type":"turn_start"}\n{"type":"turn_start"}\n'),
    ),
  );
});
test('event monitor rejects aborted or unknown settlement despite a final assistant stop', () => {
  for (const settlement of [
    { type: 'agent_settled', aborted: true },
    { type: 'agent_settled' },
    { type: 'agent_settled', aborted: 'false' },
  ]) {
    const monitor = createEventMonitor(2);
    const events = [
      { type: 'turn_start' },
      {
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop' },
      },
      settlement,
    ];
    assert.throws(
      () =>
        monitor.write(
          Buffer.from(
            events.map((event) => JSON.stringify(event)).join('\n') + '\n',
          ),
        ),
      /Agent settlement was aborted or unknown/,
    );
    assert.throws(() => monitor.finish(), /Agent did not settle successfully/);
  }
});
test('SDK adapter freezes destinations, disables retries, requests egress and TTL controls', async () => {
  const calls = [];
  const sdk = {
    create: async (...args) => {
      calls.push(args);
      return {};
    },
  };
  const adapter = new E2BAdapter('controller-canary', sdk);
  await adapter.create(
    'a:b',
    {
      jobId: 'id',
      budget: { maxWallTimeMs: 60000 },
      environment: {},
      provider: { baseUrl: 'https://gateway.example.invalid/v1' },
    },
    { policy: { allowedHosts: ['gateway.example.invalid'] } },
  );
  assert.equal(calls[0][1].apiKey, 'controller-canary');
  assert.equal(calls[0][1].domain, 'e2b.app');
  assert.equal(calls[0][1].retries, 0);
  assert.equal(calls[0][1].envs, undefined);
  assert.equal(calls[0][1].network.allowPublicTraffic, false);
  assert.equal(e2bOptions('key').apiUrl, 'https://api.e2b.app');
});
test('publisher rejects paths, credentials and private key material', () => {
  validateOutputPath('examples/todo-app/src/App.tsx');
  for (const path of [
    '.github/workflows/evil.yml',
    'examples/todo-app/../../evil',
    'examples/todo-app/.env',
    'examples/todo-app/.git/config',
    '/examples/todo-app/app',
    'examples/todo-app/node_modules/pkg/a',
    'examples/todo-app/my file',
  ])
    assert.throws(() => validateOutputPath(path));
  assert.throws(() => scanSecrets(Buffer.from('canary'), ['canary']));
  assert.throws(() => scanSecrets(Buffer.from('-----BEGIN PRIVATE KEY-----')));
});
test('publication requires verified unchanged output, is separately gated and not replayed', async (t) => {
  const f = await fixture(t);
  await runJob(f.dir, {
    live: true,
    adapter: fakeAdapter(),
    env,
    buildFile: f.buildFile,
    verifyPublic: noNetwork,
  });
  let calls = 0;
  const publisher = {
    publish: async (job, files, record) => {
      calls++;
      await record({ commit: 'b'.repeat(40) });
      return {
        commit: 'b'.repeat(40),
        branch: job.branch,
        prUrl: 'https://github.com/nextexcite/ghai-demo-cloud-agent/pull/1',
      };
    },
  };
  const options = { env, publisher, inspect: async () => [] };
  await assert.rejects(publishJob(f.dir, options), /--live/);
  const state = await publishJob(f.dir, { ...options, live: true });
  assert.equal(state.status, 'completed');
  assert.equal(calls, 1);
  await assert.rejects(publishJob(f.dir, { ...options, live: true }));
  assert.equal(calls, 1);
});
test('uncertain publication is preserved without automatic replay', async (t) => {
  const f = await fixture(t);
  await runJob(f.dir, {
    live: true,
    adapter: fakeAdapter(),
    env,
    buildFile: f.buildFile,
    verifyPublic: noNetwork,
  });
  const state = await publishJob(f.dir, {
    live: true,
    env,
    inspect: async () => [],
    publisher: {
      publish: async () => {
        throw new Error('raw private error');
      },
    },
  });
  assert.equal(state.status, 'publication_unknown');
  assert(!JSON.stringify(state).includes('raw private'));
});
test('publisher GitHub API writes only objects, new branch, and draft PR', async () => {
  const calls = [];
  const publisher = new GitHubPublisher(
    'publisher-canary',
    async (url, opts) => {
      calls.push({ url, opts });
      const body = opts.body ? JSON.parse(opts.body) : {};
      let data = {};
      if (url.endsWith('/repos/owner/repo'))
        data = { private: false, full_name: 'owner/repo' };
      else if (url.includes('/git/commits/') && opts.method === 'GET')
        data = { tree: { sha: 'tree-base' } };
      else if (url.endsWith('/git/trees')) data = { sha: 'tree-created' };
      else if (url.endsWith('/git/commits')) data = { sha: 'b'.repeat(40) };
      else if (url.endsWith('/pulls'))
        data = {
          number: 1,
          draft: true,
          head: { sha: 'b'.repeat(40) },
          html_url: 'https://github.com/owner/repo/pull/1',
        };
      return { ok: true, json: async () => data };
    },
  );
  const job = {
    repository: 'owner/repo',
    baseSha: 'a'.repeat(40),
    branch: 'ghai/todo-id',
    baseBranch: 'main',
    jobId: 'id',
    inputs: { 'product.md': 'p', 'technical.md': 't' },
  };
  await publisher.publish(job, [], async () => {});
  assert(
    calls.every((call) =>
      call.url.startsWith('https://api.github.com/repos/owner/repo'),
    ),
  );
  assert(calls.every((call) => call.opts.method !== 'PATCH'));
  assert.equal(JSON.parse(calls.at(-1).opts.body).draft, true);
});
test('CLI rejects unknown, duplicate and missing flags', () => {
  assert.throws(() => parseArgs(['run', '--secret', 'value']));
  assert.throws(() => parseArgs(['run', '--job', 'a', '--job', 'b']));
  assert.throws(() => parseArgs(['plan', '--model-env']));
  assert.equal(parseArgs(['run', '--job', 'a', '--live']).options.live, true);
});

test('installed Pi 1.1.0 accepts generated preset without network or global changes', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture(t);
  const agent = join(f.root, 'isolated-agent');
  const home = join(f.root, 'home');
  await mkdir(agent);
  await mkdir(home);
  for (const [name, value] of Object.entries(piConfig(f.job)))
    await writeJson(join(agent, name), value);
  const cli = fileURLToPath(
    new URL(
      '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      import.meta.url,
    ),
  );
  const guard = fileURLToPath(
    new URL('./offline-network.mjs', import.meta.url),
  );
  const result = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      guard,
      cli,
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-approve',
      '--no-mcp',
      '--offline',
      '--list-models',
      'ghai',
    ],
    {
      cwd: home,
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: '1',
        GHAI_API_KEY: 'offline-fixture',
      },
    },
  );
  assert(result.stdout.includes(model.id));
  assert.equal(await readFile(f.modelsFile, 'utf8'), JSON.stringify(config));
});

test('actual git patch inspection applies scoped files without executing project code', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir, cp } = await import('node:fs/promises');
  const { inspectPatch } =
    await import('../recipes/02-e2b-development/publish.mjs');
  const f = await fixture(t);
  const base = join(f.root, 'base');
  await mkdir(base);
  const git = async (...args) =>
    (
      await promisify(execFile)('git', args, {
        cwd: base,
        env: {
          PATH: process.env.PATH,
          HOME: f.root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      })
    ).stdout;
  await git('init', '--quiet');
  await writeFile(join(base, 'README.md'), 'base\n');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'base',
  );
  const baseSha = (await git('rev-parse', 'HEAD')).trim();
  await writeFile(join(f.dir, 'changes.patch'), patch);
  const files = await inspectPatch(
    f.dir,
    { ...f.job, baseSha },
    Buffer.from(patch),
    {
      prepareBase: async (work) =>
        cp(join(base, '.git/objects'), join(work, '.git/objects'), {
          recursive: true,
        }),
    },
  );
  assert.deepEqual(files, [
    {
      path: 'examples/todo-app/README.md',
      mode: '100644',
      type: 'blob',
      content: Buffer.from('hello\n').toString('base64'),
    },
  ]);
});

test('offline guard rejects remote fetch and socket before connection', async () => {
  const { Socket } = await import('node:net');
  await assert.rejects(
    fetch('https://example.invalid/never'),
    /Offline test blocked/,
  );
  const socket = new Socket();
  assert.throws(
    () => socket.connect({ host: 'example.invalid', port: 443 }),
    /Offline test blocked/,
  );
  socket.destroy();
});

test('concurrent runs reserve once before sandbox creation', async (t) => {
  const f = await fixture(t);
  const adapter = fakeAdapter();
  const options = {
    live: true,
    adapter,
    env,
    buildFile: f.buildFile,
    verifyPublic: async () => new Promise((resolve) => setTimeout(resolve, 20)),
  };
  const results = await Promise.allSettled([
    runJob(f.dir, options),
    runJob(f.dir, options),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    adapter.calls.filter((call) => call.action === 'create').length,
    1,
  );
});
test('concurrent publication reserves once before GitHub writes', async (t) => {
  const f = await fixture(t);
  await runJob(f.dir, {
    live: true,
    adapter: fakeAdapter(),
    env,
    buildFile: f.buildFile,
    verifyPublic: noNetwork,
  });
  let writes = 0;
  const options = {
    live: true,
    env,
    inspect: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [];
    },
    publisher: {
      publish: async () => {
        writes++;
        return { commit: 'b'.repeat(40) };
      },
    },
  };
  const results = await Promise.allSettled([
    publishJob(f.dir, options),
    publishJob(f.dir, options),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(writes, 1);
});
test('installed Pi exact native MCP probe syntax accepts isolated empty configuration', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture(t);
  const agent = join(f.root, 'probe-agent');
  const home = join(f.root, 'probe-home');
  await mkdir(agent);
  await mkdir(home);
  await writeJson(join(agent, 'mcp.json'), { mcpServers: {} });
  const runner = await readFile(
    new URL('../recipes/02-e2b-development/remote-runner.mjs', import.meta.url),
    'utf8',
  );
  assert(runner.includes("['mcp', 'list', '--json']"));
  const cli = fileURLToPath(
    new URL(
      '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      import.meta.url,
    ),
  );
  const guard = fileURLToPath(
    new URL('./offline-network.mjs', import.meta.url),
  );
  const output = await promisify(execFile)(
    process.execPath,
    ['--import', guard, cli, 'mcp', 'list', '--json'],
    {
      cwd: home,
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: '1',
      },
    },
  );
  assert.doesNotThrow(() => JSON.parse(output.stdout));
});

test('cleanup and status remain available after frozen specs change', async (t) => {
  const f = await fixture(t);
  const adapter = fakeAdapter({ failCreate: true });
  await runJob(f.dir, {
    live: true,
    adapter,
    env,
    buildFile: f.buildFile,
    verifyPublic: noNetwork,
  });
  await writeFile(join(f.dir, 'product.md'), 'accidentally edited');
  assert.equal(
    (await loadJob(f.dir, { verifyInputs: false })).state.status,
    'unknown',
  );
  const state = await cancelJob(f.dir, { live: true, adapter, env });
  assert.equal(state.cleanup, 'killed');
});
test('signal during public validation cancels before provisioning', async (t) => {
  const f = await fixture(t);
  const adapter = fakeAdapter();
  const state = await runJob(f.dir, {
    live: true,
    adapter,
    env,
    buildFile: f.buildFile,
    verifyPublic: async () => {
      process.emit('SIGINT');
    },
  });
  assert.equal(state.status, 'cancelled');
  assert.equal(state.cleanup, 'not-created');
  assert.equal(adapter.calls.length, 0);
});

test('provider configuration has no literal fallback and rejects unsafe or mismatched destinations', async (t) => {
  const { validateBaseUrl } =
    await import('../recipes/02-e2b-development/core.mjs');
  assert.throws(() => validateBaseUrl(undefined), /must be configured/);
  for (const url of [
    'http://gateway.example.invalid/v1',
    'https://user:pass@gateway.example.invalid/v1',
    'https://gateway.example.invalid/v1?secret=x',
    'https://gateway.example.invalid/v1#fragment',
  ])
    assert.throws(() => validateBaseUrl(url));
  assert.throws(() =>
    selectModel(config, model.id, 'https://other.example.invalid/v1'),
  );
  await assert.rejects(fixture(t, { baseUrl: undefined }));
  await assert.rejects(fixture(t, { model: undefined }));
});
test('selected private provider values are blocked from public patches', async (t) => {
  for (const value of [
    config.providers.ghai.baseUrl,
    'gateway.example.invalid',
    model.id,
  ]) {
    const f = await fixture(t);
    const state = await runJob(f.dir, {
      live: true,
      adapter: fakeAdapter({ patch: patch + value }),
      env,
      buildFile: f.buildFile,
      verifyPublic: noNetwork,
    });
    assert.equal(state.status, 'failed');
  }
});
test('manifest budget fields require bounded integers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'manifest-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(
      new URL(
        '../recipes/02-e2b-development/environment.manifest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const name of ['maxWallTimeMs', 'maxObservedTurns', 'maxPatchBytes']) {
    const copy = structuredClone(manifest);
    copy.policy[name] = String(copy.policy[name]);
    const path = join(root, `${name}.json`);
    await writeJson(path, copy);
    await assert.rejects(fixture(t, { manifest: path }));
  }
});

test('simple plan defaults use existing Pi configuration and validated GitHub origin', async () => {
  const defaults = await planDefaults(
    { repo: 'owner/repo', 'base-sha': 'a'.repeat(40) },
    { HOME: '/fixture-home' },
  );
  assert.equal(defaults.modelsFile, '/fixture-home/.pi/agent/models.json');
  const custom = await planDefaults(
    { repo: 'owner/repo', 'base-sha': 'a'.repeat(40) },
    { PI_MODELS_FILE: '/fixture/presets.json' },
  );
  assert.equal(custom.modelsFile, '/fixture/presets.json');
  for (const origin of [
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'https://github.com/owner/repo',
  ])
    assert.equal(repositoryFromOrigin(origin), 'owner/repo');
  for (const origin of [
    'https://token@github.com/owner/repo.git',
    'https://other.invalid/owner/repo',
    '/local/repo',
  ])
    assert.throws(() => repositoryFromOrigin(origin), /Origin must/);
  for (const command of ['plan', 'status', 'build'])
    assert.equal(parseArgs([command]).command, command);
});

test('dotenv setup contains names only and is never included in template uploads', async () => {
  const { TEMPLATE_FILES } =
    await import('../recipes/02-e2b-development/template.mjs');
  const root = new URL('../', import.meta.url);
  const sample = await readFile(new URL('env.example', root), 'utf8');
  const entries = sample
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(entries, [
    'E2B_API_KEY=',
    'GHAI_API_KEY=',
    'GHAI_PI_BASE_URL=',
    'GHAI_PI_PRIMARY_MODEL=',
    'CONTEXT7_API_KEY=',
    'GH_TOKEN=',
  ]);
  assert.equal(
    (await readFile(new URL('.envrc', root), 'utf8')).trim(),
    'dotenv_if_exists .env',
  );
  assert(
    (await readFile(new URL('.gitignore', root), 'utf8'))
      .split('\n')
      .includes('.env'),
  );
  assert(
    TEMPLATE_FILES.every(([source]) => !/env(?:rc|\.example)?$/.test(source)),
  );
});

test('no-flags CLI plan resolves origin and HEAD, freezes default key names, and never copies dotenv', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'e2b-cli-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const environment = {
    PATH: process.env.PATH,
    HOME: root,
    PI_CODING_AGENT_DIR: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GHAI_PI_BASE_URL: config.providers.ghai.baseUrl,
    GHAI_PI_PRIMARY_MODEL: model.id,
    E2B_API_KEY: 'local-controller-secret-canary',
    GHAI_API_KEY: 'model-secret-canary',
    CONTEXT7_API_KEY: 'context-secret-canary',
    GH_TOKEN: 'publisher-secret-canary',
  };
  const git = async (...args) =>
    (await exec('git', args, { cwd: root, env: environment })).stdout.trim();
  await git('init', '--quiet');
  await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  await writeFile(join(root, 'README.md'), 'fixture');
  await git('add', 'README.md');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  const head = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'models.json'), JSON.stringify(config));
  await writeFile(join(root, '.env'), 'PRIVATE_FILE=dotenv-secret-canary\n');
  const cli = fileURLToPath(
    new URL('../recipes/02-e2b-development/cli.mjs', import.meta.url),
  );
  const guard = fileURLToPath(
    new URL('./offline-network.mjs', import.meta.url),
  );
  const result = await exec(
    process.execPath,
    ['--import', guard, cli, 'plan'],
    { cwd: root, env: environment },
  );
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.repository, 'owner/repo');
  assert.equal(summary.baseSha, head);
  assert.deepEqual(summary.environmentNames, {
    e2b: 'E2B_API_KEY',
    ghai: 'GHAI_API_KEY',
    context7: 'CONTEXT7_API_KEY',
    github: 'GH_TOKEN',
  });
  const loaded = await loadJob(join(root, 'artifacts/todo-job'));
  const stored = JSON.stringify(loaded);
  for (const secret of [
    environment.E2B_API_KEY,
    environment.GHAI_API_KEY,
    environment.CONTEXT7_API_KEY,
    environment.GH_TOKEN,
    'dotenv-secret-canary',
  ]) {
    assert(!stored.includes(secret));
    assert(!result.stdout.includes(secret));
  }
  const missingKeyEnv = { ...environment };
  delete missingKeyEnv.E2B_API_KEY;
  await assert.rejects(
    exec(process.execPath, ['--import', guard, cli, 'build', '--live'], {
      cwd: root,
      env: missingKeyEnv,
    }),
    (error) => {
      assert.match(
        error.stderr,
        /Missing environment variable: E2B_API_KEY.*direnv allow/,
      );
      return true;
    },
  );
});
