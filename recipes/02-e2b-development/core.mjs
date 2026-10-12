import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  stat,
  open,
} from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox } from 'e2b';

export const recipeDir = dirname(fileURLToPath(import.meta.url));
export const remoteRoot = '/home/user/ghai-job';
export const bin = '/opt/ghai-delegation/bin';
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export const runtimeHelpers = ['decision.mjs', 'browser-qa.mjs'];
export const checks = ['lint', 'typecheck', 'test', 'build'];
const envPattern = /^[A-Z_][A-Z0-9_]{0,127}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[a-f0-9]{40}$/;

export async function readSmall(path, max = 200000) {
  assert((await stat(path)).size <= max, 'Input exceeds size limit');
  const bytes = await readFile(path);
  assert(bytes.length <= max, 'Input exceeds size limit');
  return bytes.toString('utf8');
}
export async function reserveAction(dir, action, jobId) {
  let file;
  try {
    file = await open(join(dir, `${action}.reserved`), 'wx', 0o600);
  } catch (error) {
    assert(
      error.code !== 'EEXIST',
      `${action} is already reserved; inspect the existing outcome instead of replaying it`,
    );
    throw error;
  }
  try {
    await file.writeFile(
      JSON.stringify({ jobId, action, reservedAt: new Date().toISOString() }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function writeJson(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}
export function validateEnvironment(names) {
  assert(names && typeof names === 'object');
  for (const key of ['e2b', 'ghai', 'context7', 'github'])
    assert(
      envPattern.test(names[key]),
      `Choose ${key} environment variable name`,
    );
  assert.deepEqual(
    Object.keys(names).sort(),
    ['context7', 'e2b', 'ghai', 'github'],
    'Only the four declared credential roles are supported',
  );
  assert.equal(
    new Set(Object.values(names)).size,
    Object.values(names).length,
    'Credential roles require distinct variable names',
  );
}
export function validateBaseUrl(value) {
  assert(
    typeof value === 'string' && value.length > 0,
    'GHAI_BASE_URL must be configured',
  );
  const url = new URL(value);
  assert(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'GHAI base URL must be HTTPS without credentials, query or fragment',
  );
  return value.replace(/\/$/, '');
}
export function selectModel(config, id, endpoint) {
  assert(
    typeof id === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/.test(id),
    'GHAI_PI_PRIMARY_MODEL must contain an exact configured model ID',
  );
  const provider = config.providers?.ghai;
  assert.equal(
    provider?.baseUrl,
    validateBaseUrl(endpoint),
    'Use the configured GHAI endpoint',
  );
  const source = provider.models?.find((model) => model.id === id);
  assert(
    source,
    'Exact model not found in existing ghai models.json; export a nonsecret models.json preset first',
  );
  assert.equal(
    source.api ?? provider.api,
    'openai-responses',
    'Recipe requires an existing Responses preset',
  );
  const model = {};
  for (const key of [
    'id',
    'name',
    'reasoning',
    'input',
    'contextWindow',
    'maxTokens',
    'compat',
    'thinkingLevelMap',
    'samplingParams',
    'samplingParamsByThinkingLevel',
  ]) {
    if (source[key] !== undefined) model[key] = structuredClone(source[key]);
  }
  if (!model.compat && provider.compat)
    model.compat = structuredClone(provider.compat);
  // Never copy auth, headers, command interpolation, provider extensions or other providers.
  assert(
    !JSON.stringify(model).includes('${') &&
      !JSON.stringify(model).includes('!'),
    'Preset metadata must be literal nonsecret data',
  );
  assert(
    Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0,
    'Explicit contextWindow required',
  );
  assert(
    Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0,
    'Explicit maxTokens required',
  );
  assert(
    typeof model.reasoning === 'boolean',
    'Explicit reasoning support required',
  );
  assert(
    Array.isArray(model.input) &&
      model.input.includes('text') &&
      model.input.every((x) => ['text', 'image'].includes(x)),
    'Invalid model input capabilities',
  );
  model.api = 'openai-responses';
  model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return model;
}
export async function planJob(options) {
  assert(repoPattern.test(options.repository), 'Repository must be owner/name');
  assert(
    shaPattern.test(options.baseSha),
    'Exact 40-character base SHA required',
  );
  assert(
    /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(options.baseBranch ?? 'main') &&
      !String(options.baseBranch).includes('..'),
    'Invalid base branch',
  );
  validateEnvironment(options.environment);
  const manifestText = await readSmall(
    options.manifest ?? join(recipeDir, 'environment.manifest.json'),
  );
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.recipe, '02-e2b-development');
  assert.equal(manifest.provider.baseUrlEnv, 'GHAI_BASE_URL');
  assert.equal(manifest.provider.modelEnv, 'GHAI_PI_PRIMARY_MODEL');
  assert.deepEqual(manifest.capabilities.mcp, ['context7']);
  assert.deepEqual(Object.keys(manifest.environment).sort(), [
    'context7',
    'e2b',
    'ghai',
    'github',
  ]);
  assert(Number.isSafeInteger(manifest.policy.maxWallTimeMs));
  assert(Number.isSafeInteger(manifest.policy.maxObservedTurns));
  assert(
    Number.isSafeInteger(manifest.policy.maxPatchBytes) &&
      manifest.policy.maxPatchBytes > 0 &&
      manifest.policy.maxPatchBytes <= 2000000,
  );
  assert.deepEqual(manifest.policy.allowedPaths, ['examples/todo-app/']);
  assert(
    manifest.policy.maxWallTimeMs >= 60000 &&
      manifest.policy.maxWallTimeMs <= 1800000,
  );
  assert(
    manifest.policy.maxObservedTurns > 0 &&
      manifest.policy.maxObservedTurns <= 100,
  );
  assert.equal(manifest.toolchain.pi, '1.1.0');
  const product = await readSmall(
    options.product ?? join(recipeDir, 'specs/product.md'),
  );
  const technical = await readSmall(
    options.technical ?? join(recipeDir, 'specs/technical.md'),
  );
  assert(
    product.length > 200 && /acceptance/i.test(product),
    'Product spec must include acceptance criteria',
  );
  assert(
    technical.length > 200 && /verification/i.test(technical),
    'Technical spec must include verification',
  );
  const model = selectModel(
    JSON.parse(await readSmall(options.modelsFile)),
    options.model,
    options.baseUrl,
  );
  assert(
    /^[A-Za-z0-9_.:/-]{1,200}$/.test(options.decisionModel || 'jev-latest'),
    'Invalid decision model',
  );
  assert(
    new URL(options.baseUrl).pathname.replace(/\/$/, '') === '/v1',
    'GHAI_BASE_URL must end in /v1',
  );
  const dir = resolve(options.jobDir);
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir, { mode: 0o700 }); // No overwrite/reuse of a prior job.
  const files = {
    'product.md': product,
    'technical.md': technical,
    'environment.manifest.json': manifestText,
  };
  for (const [name, text] of Object.entries(files))
    await writeFile(join(dir, name), text, { flag: 'wx', mode: 0o600 });
  const job = {
    schemaVersion: 1,
    jobId: randomUUID(),
    repository: options.repository,
    baseSha: options.baseSha,
    baseBranch: options.baseBranch ?? 'main',
    inputs: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, hash(text)]),
    ),
    runnerSha256: hash(await readSmall(join(recipeDir, 'remote-runner.mjs'))),
    helperHashes: Object.fromEntries(
      await Promise.all(
        runtimeHelpers.map(async (name) => [
          name,
          hash(await readSmall(join(recipeDir, name))),
        ]),
      ),
    ),
    decision: {
      model: options.decisionModel || 'jev-latest',
      maxCalls: 2,
      maxRepairs: 1,
    },
    provider: {
      baseUrl: validateBaseUrl(options.baseUrl),
      api: 'openai-responses',
    },
    configurationNames: options.configurationNames ?? {
      baseUrl: 'GHAI_BASE_URL',
      model: 'GHAI_PI_PRIMARY_MODEL',
    },
    model,
    environment: options.environment,
    budget: {
      maxWallTimeMs: manifest.policy.maxWallTimeMs,
      maxObservedTurns: manifest.policy.maxObservedTurns,
      actualBillingUsd: null,
    },
    allowedPaths: manifest.policy.allowedPaths,
    verification: checks,
    publication: 'draft-pr-only',
  };
  job.branch = `ghai/todo-${job.jobId}`;
  await writeJson(join(dir, 'job.json'), job);
  await writeJson(join(dir, 'state.json'), {
    status: 'prepared',
    jobHash: hash(JSON.stringify(job)),
    cleanup: 'not-created',
  });
  return job;
}
export async function loadJob(dir, { verifyInputs = true } = {}) {
  const job = JSON.parse(await readSmall(join(dir, 'job.json')));
  const state = JSON.parse(await readSmall(join(dir, 'state.json')));
  assert.equal(
    state.jobHash,
    hash(JSON.stringify(job)),
    'Job changed after preparation',
  );
  assert.equal(job.schemaVersion, 1);
  assert(repoPattern.test(job.repository) && shaPattern.test(job.baseSha));
  validateEnvironment(job.environment);
  validateBaseUrl(job.provider.baseUrl);
  if (!verifyInputs) return { job, state };
  const inputContents = {};
  for (const [name, digest] of Object.entries(job.inputs)) {
    assert(
      ['product.md', 'technical.md', 'environment.manifest.json'].includes(
        name,
      ),
    );
    inputContents[name] = await readSmall(join(dir, name));
    assert.equal(hash(inputContents[name]), digest, 'Frozen input changed');
  }
  assert.deepEqual(Object.keys(job.inputs).sort(), [
    'environment.manifest.json',
    'product.md',
    'technical.md',
  ]);
  const runner = await readSmall(join(recipeDir, 'remote-runner.mjs'));
  assert.equal(
    hash(runner),
    job.runnerSha256,
    'Runner changed after preparation; create a new plan',
  );
  const helpers = {};
  for (const name of runtimeHelpers) {
    helpers[name] = await readSmall(join(recipeDir, name));
    assert.equal(
      hash(helpers[name]),
      job.helperHashes?.[name],
      'QA helper changed; create a new plan',
    );
  }
  return {
    job,
    state,
    helpers,
    inputContents,
    runner,
    manifest: JSON.parse(inputContents['environment.manifest.json']),
  };
}
export function resolveSecrets(job, env, roles) {
  const result = {};
  for (const role of roles) {
    const name = job.environment[role];
    assert(
      typeof env[name] === 'string' && env[name].length > 0,
      `Missing environment variable: ${name}. Set it in the local process environment or ignored .env, then run direnv allow; never put credential values in arguments.`,
    );
    result[role] = env[name];
  }
  assert.equal(
    new Set(Object.values(result)).size,
    Object.values(result).length,
    'Do not reuse credentials across roles',
  );
  return result;
}
export function piConfig(job) {
  const mcpServers = {
    context7: {
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer ${CONTEXT7_RUNTIME_KEY}' },
      exposure: 'direct',
    },
  };
  return {
    'models.json': {
      providers: {
        ghai: {
          api: 'openai-responses',
          baseUrl: job.provider.baseUrl,
          apiKey: '${GHAI_API_KEY}',
          models: [job.model],
        },
      },
    },
    'settings.json': {
      defaultProjectTrust: 'never',
      cacheWarming: 'off',
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      packages: [],
    },
    'auth.json': {},
    'mcp.json': { mcpServers },
  };
}
export function e2bOptions(apiKey) {
  return {
    apiKey,
    domain: 'e2b.app',
    apiUrl: 'https://api.e2b.app',
    sandboxUrl: 'https://sandbox.e2b.app',
    debug: false,
    retries: 0,
    requestTimeoutMs: 30000,
  };
}
export class E2BAdapter {
  constructor(apiKey, sdk = Sandbox) {
    this.options = e2bOptions(apiKey);
    this.sdk = sdk;
  }
  create(template, job, manifest) {
    return this.sdk.create(template, {
      ...this.options,
      timeoutMs: job.budget.maxWallTimeMs + 120000,
      lifecycle: { onTimeout: 'kill' },
      metadata: { recipe: 'ghai-development', jobId: job.jobId },
      network: {
        allowPublicTraffic: false,
        denyOut: ['0.0.0.0/0'],
        allowOut: [
          ...manifest.policy.allowedHosts,
          new URL(job.provider.baseUrl).hostname,
        ],
      },
    });
  }
  async list(jobId) {
    const pager = this.sdk.list({
      ...this.options,
      query: { metadata: { jobId, recipe: 'ghai-development' } },
    });
    const result = [];
    while (pager.hasNext) result.push(...(await pager.nextItems()));
    return result;
  }
  kill(id) {
    return this.sdk.kill(id, this.options);
  }
}
async function command(sandbox, text, opts = {}) {
  const result = await sandbox.commands.run(text, {
    timeoutMs: 60000,
    ...opts,
  });
  assert.equal(
    result.exitCode,
    0,
    'Sandbox command failed; raw output withheld',
  );
  return result.stdout;
}
export async function runJob(
  dir,
  { live = false, buildFile, env = process.env, adapter, verifyPublic } = {},
) {
  assert(live, 'Live sandbox/inference requires --live');
  const { job, state, manifest, inputContents, runner, helpers } =
    await loadJob(dir);
  assert.equal(
    state.status,
    'prepared',
    'A job cannot be replayed; inspect status and use a new approved plan',
  );
  assert(
    typeof buildFile === 'string',
    'Build the template first and provide --template-build PATH',
  );
  const build = JSON.parse(await readSmall(buildFile));
  assert.equal(
    build.status,
    'ready',
    'Template descriptor must record a completed build',
  );
  assert.equal(
    build.toolchain?.agentBrowser,
    manifest.toolchain.agentBrowser,
    'Template browser pin mismatch',
  );
  assert.equal(
    build.toolchain?.pi,
    manifest.toolchain.pi,
    'Template Pi pin mismatch',
  );
  assert.equal(
    build.toolchain?.node,
    manifest.toolchain.node,
    'Template Node pin mismatch',
  );
  assert.equal(
    build.toolchain?.pnpm,
    manifest.toolchain.pnpm,
    'Template pnpm pin mismatch',
  );
  assert.equal(
    build.toolchain?.mise,
    manifest.toolchain.mise,
    'Template mise pin mismatch',
  );
  assert.equal(
    build.toolchain?.platform,
    manifest.platforms.sandbox,
    'Template platform mismatch',
  );
  assert.equal(
    build.sdk?.version,
    manifest.toolchain.e2b,
    'Template SDK pin mismatch',
  );
  assert(
    /^[A-Za-z0-9_-]+$/.test(build.templateId ?? ''),
    'Build an E2B template first',
  );
  assert(
    /^[A-Za-z0-9_-]+$/.test(build.buildId ?? ''),
    'Immutable template build ID required',
  );
  const secrets = resolveSecrets(job, env, ['e2b', 'ghai', 'context7']);
  const client = adapter ?? new E2BAdapter(secrets.e2b);
  await reserveAction(dir, 'run', job.jobId);
  // Reserve before a potentially ambiguous control-plane request. No automatic replay.
  state.status = 'provisioning';
  state.startedAt = new Date().toISOString();
  state.cleanup = 'not-created';
  state.template = `${build.templateId}:${build.buildId}`;
  state.templateDescriptorSha256 = hash(JSON.stringify(build));
  await writeJson(join(dir, 'state.json'), state);
  let sandbox;
  let timer;
  let cancelled = false;
  let createRequested = false;
  const stop = () => {
    cancelled = true;
    if (sandbox) void sandbox.kill().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await (verifyPublic ?? verifyPublicRepository)(job);
    assert(!cancelled, 'Cancelled before provisioning');
    state.cleanup = 'unknown';
    await writeJson(join(dir, 'state.json'), state);
    assert(!cancelled, 'Cancelled before provisioning');
    createRequested = true;
    sandbox = await client.create(
      `${build.templateId}:${build.buildId}`,
      job,
      manifest,
    );
    state.sandboxId = sandbox.sandboxId;
    if (cancelled) throw new Error('Cancelled');
    state.status = 'running';
    await writeJson(join(dir, 'state.json'), state);
    timer = setTimeout(() => {
      void sandbox.kill().catch(() => {});
    }, job.budget.maxWallTimeMs);
    await command(
      sandbox,
      `mkdir -p ${remoteRoot}/agent ${remoteRoot}/inputs ${remoteRoot}/home && git -c credential.helper= clone --no-checkout https://github.com/${job.repository}.git ${remoteRoot}/repo && cd ${remoteRoot}/repo && git -c core.hooksPath=/dev/null checkout --detach ${job.baseSha}`,
      {
        timeoutMs: 120000,
        envs: {
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    );
    assert.equal(
      (
        await command(sandbox, `git -C ${remoteRoot}/repo rev-parse HEAD`)
      ).trim(),
      job.baseSha,
    );
    const uploads = [
      {
        path: `${remoteRoot}/remote-runner.mjs`,
        data: runner,
      },
      { path: `${remoteRoot}/job.json`, data: JSON.stringify(job) },
    ];
    for (const [name, data] of Object.entries(helpers))
      uploads.push({ path: `${remoteRoot}/${name}`, data });
    for (const name of ['product.md', 'technical.md'])
      uploads.push({
        path: `${remoteRoot}/inputs/${name}`,
        data: inputContents[name],
      });
    for (const [name, data] of Object.entries(piConfig(job)))
      uploads.push({
        path: `${remoteRoot}/agent/${name}`,
        data: JSON.stringify(data),
      });
    await sandbox.files.write(uploads);
    const runtimeEnv = {
      GHAI_API_KEY: secrets.ghai,
      CONTEXT7_RUNTIME_KEY: secrets.context7,
    };
    const execution = JSON.parse(
      await command(sandbox, `${bin}/node ${remoteRoot}/remote-runner.mjs`, {
        timeoutMs: job.budget.maxWallTimeMs,
        envs: runtimeEnv,
      }),
    );
    assert.equal(
      execution.status,
      'completed',
      'Remote agent did not complete successfully',
    );
    state.status = 'verifying';
    await writeJson(join(dir, 'state.json'), state);
    const verification = [];
    for (const check of checks) {
      await command(
        sandbox,
        `cd ${remoteRoot}/repo/examples/todo-app && ${bin}/pnpm run ${check}`,
        { timeoutMs: 120000, envs: { CI: '1' } },
      );
      verification.push({ check, status: 'passed' });
    }
    // Include new files while retaining the immutable base for comparison.
    await command(
      sandbox,
      `cd ${remoteRoot}/repo && git -c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null diff --cached --binary ${job.baseSha} > ${remoteRoot}/changes.patch && wc -c < ${remoteRoot}/changes.patch`,
    );
    const info = await sandbox.files.getInfo(`${remoteRoot}/changes.patch`);
    assert(info.size <= manifest.policy.maxPatchBytes, 'Patch exceeds limit');
    const patch = await sandbox.files.read(`${remoteRoot}/changes.patch`);
    assert(
      Buffer.byteLength(patch) <= manifest.policy.maxPatchBytes &&
        patch.length > 0,
      'Empty or oversized patch',
    );
    assert.equal(hash(patch), execution.patchSha256, 'Patch changed after QA');
    assert.equal(
      execution.rounds?.at(-1)?.action,
      'ready_for_review',
      'QA decision missing',
    );
    for (const secret of Object.values(secrets))
      assert(
        !patch.includes(secret),
        'Credential found in patch; publication blocked',
      );
    const { validateOutputPath, scanSecrets } = await import('./publish.mjs');
    const headers = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
    assert(
      headers.length > 0 && headers.length <= 250,
      'Invalid patch file count',
    );
    for (const [, oldPath, newPath] of headers) {
      validateOutputPath(oldPath, job.allowedPaths);
      validateOutputPath(newPath, job.allowedPaths);
    }
    assert(
      !/^(?:new file mode|new mode) (?:120000|160000)$/m.test(patch),
      'Symlinks/submodules are forbidden',
    );
    scanSecrets(
      Buffer.from(patch),
      [
        ...Object.values(secrets),
        job.provider.baseUrl,
        new URL(job.provider.baseUrl).hostname,
        job.model.id,
        job.model.name,
      ].filter(Boolean),
    );
    await writeFile(join(dir, 'changes.patch'), patch, {
      flag: 'wx',
      mode: 0o600,
    });
    const result = {
      schemaVersion: 1,
      jobId: job.jobId,
      baseSha: job.baseSha,
      patchSha256: hash(patch),
      verification,
      agent: execution,
      actualBillingUsd: null,
      note: 'Sandbox tests are evidence, not a security attestation. Review the patch before publishing.',
    };
    await writeJson(join(dir, 'result.json'), result);
    state.status = 'ready_to_publish';
    state.patchSha256 = result.patchSha256;
  } catch {
    if (!createRequested) state.cleanup = 'not-created';
    state.status = cancelled
      ? 'cancelled'
      : sandbox
        ? 'failed'
        : createRequested
          ? 'unknown'
          : 'blocked';
    state.error = sandbox
      ? 'Execution or verification failed; raw output withheld'
      : createRequested
        ? 'Sandbox creation outcome unknown; reconcile before a new attempt'
        : 'Public repository validation failed before sandbox creation';
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (sandbox) {
      try {
        await sandbox.kill();
        state.cleanup = 'killed';
      } catch {
        state.cleanup = 'unconfirmed';
      }
    }
    state.finishedAt = new Date().toISOString();
    await writeJson(join(dir, 'state.json'), state);
  }
  return state;
}
export async function verifyPublicRepository(job) {
  const response = await fetch(
    `https://api.github.com/repos/${job.repository}`,
    {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json' },
    },
  );
  assert.equal(response.status, 200, 'Cannot verify public repository');
  const repository = await response.json();
  assert.equal(
    repository.private,
    false,
    'Only public repositories are supported',
  );
  assert.equal(
    repository.full_name.toLowerCase(),
    job.repository.toLowerCase(),
  );
}
export async function cancelJob(
  dir,
  { live = false, env = process.env, adapter } = {},
) {
  assert(live, 'Cancellation requires --live');
  const { job, state } = await loadJob(dir, { verifyInputs: false });
  assert(state.status !== 'prepared', 'No sandbox was requested');
  const client =
    adapter ?? new E2BAdapter(resolveSecrets(job, env, ['e2b']).e2b);
  const ids = state.sandboxId
    ? [state.sandboxId]
    : (await client.list(job.jobId)).map((s) => s.sandboxId);
  assert(
    ids.length > 0,
    'No sandbox identified; do not infer absence or replay the job',
  );
  for (const id of ids) await client.kill(id);
  state.cleanup = 'killed';
  if (!['completed', 'ready_to_publish'].includes(state.status))
    state.status = 'cancelled';
  await writeJson(join(dir, 'state.json'), state);
  return state;
}
