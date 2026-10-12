#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { planJob, runJob, loadJob, cancelJob } from './core.mjs';
import { publishJob } from './publish.mjs';
import { buildTemplate } from './template.mjs';
const exec = promisify(execFile);
const usage = `Spec-first E2B development (offline by default)
  doctor
  plan
  build --live
  run --live
  status
  cancel --live
  publish --live
Copy env.example to .env, fill it locally, then review .envrc and run direnv allow.
E2B_API_KEY is used by both builder and controller. Never pass credential values.
Plan defaults to Git origin + HEAD, your existing Pi models.json, and artifacts/todo-job.
Advanced plan overrides: --models-file PATH --repo OWNER/REPO --base-sha SHA
  --base main --job DIRECTORY --product PATH --technical PATH --manifest PATH
  --model-env NAME --base-url-env NAME --e2b-env NAME --ghai-env NAME
  --context7-env NAME --github-env NAME
Build overrides: --name NAME --out PATH --api-key-env NAME
Run override: --template-build PATH. All job commands accept --job DIRECTORY.
Live build/run/publish are separate explicit actions.
`;
export function repositoryFromOrigin(origin) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      origin,
    );
  assert(
    match,
    'Origin must be a public GitHub HTTPS/SSH repository URL without embedded credentials; use --repo OWNER/REPO',
  );
  return match[1];
}
export async function planDefaults(
  options,
  env = process.env,
  cwd = process.cwd(),
) {
  const gitRead = async (args) =>
    (
      await exec('git', args, {
        cwd,
        timeout: 10000,
        maxBuffer: 2000,
        env: {
          PATH: env.PATH,
          HOME: env.HOME ?? homedir(),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      })
    ).stdout.trim();
  const modelsFile =
    options['models-file'] ||
    env.PI_MODELS_FILE ||
    join(
      env.PI_CODING_AGENT_DIR || join(env.HOME ?? homedir(), '.pi', 'agent'),
      'models.json',
    );
  return {
    modelsFile: resolve(modelsFile),
    repository:
      options.repo ||
      repositoryFromOrigin(await gitRead(['remote', 'get-url', 'origin'])),
    baseSha:
      options['base-sha'] || (await gitRead(['rev-parse', '--verify', 'HEAD'])),
  };
}
export function parseArgs(args) {
  const command = args.shift();
  const options = {};
  const accepted = {
    doctor: [],
    build: ['live', 'name', 'out', 'api-key-env'],
    plan: [
      'models-file',
      'model-env',
      'base-url-env',
      'repo',
      'base-sha',
      'base',
      'e2b-env',
      'ghai-env',
      'context7-env',
      'github-env',
      'job',
      'product',
      'technical',
      'manifest',
    ],
    run: ['job', 'template-build', 'live'],
    status: ['job'],
    cancel: ['job', 'live'],
    publish: ['job', 'live'],
  };
  assert(Object.hasOwn(accepted, command), usage);
  while (args.length) {
    const key = args.shift();
    assert(
      key.startsWith('--') && accepted[command].includes(key.slice(2)),
      'Unknown option',
    );
    assert(!Object.hasOwn(options, key.slice(2)), 'Duplicate option');
    const value = key === '--live' ? true : args.shift();
    assert(
      value !== undefined && (value === true || !value.startsWith('--')),
      'Option value missing',
    );
    options[key.slice(2)] = value;
  }
  return { command, options };
}
export async function main(args = process.argv.slice(2)) {
  if (!args.length || ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return;
  }
  const { command, options: o } = parseArgs(args);
  if (command === 'doctor') {
    assert(
      ['linux', 'darwin'].includes(process.platform),
      'Controller supports Linux and macOS',
    );
    assert.equal(
      Number(process.versions.node.split('.')[0]),
      24,
      'Use the pinned Node 24 toolchain',
    );
    const tools = {};
    const temporaryHome = await mkdtemp(join(tmpdir(), 'ghai-doctor-'));
    try {
      for (const name of ['git', 'pnpm', 'pi']) {
        try {
          tools[name] = (
            await exec(name, ['--version'], {
              timeout: 10000,
              maxBuffer: 1000,
              cwd: temporaryHome,
              env: {
                PATH: process.env.PATH,
                HOME: temporaryHome,
                PI_CODING_AGENT_DIR: join(temporaryHome, 'pi'),
                PI_OFFLINE: '1',
                COREPACK_ENABLE_NETWORK: '0',
                npm_config_offline: 'true',
              },
            })
          ).stdout.trim();
        } catch {
          tools[name] = 'not found or version check failed';
        }
      }
    } finally {
      await rm(temporaryHome, { recursive: true, force: true });
    }
    console.log(
      JSON.stringify(
        {
          platform: `${process.platform}-${process.arch}`,
          node: process.version,
          tools,
          liveServicesChecked: false,
          globalConfigurationModified: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'build') {
    const args = Object.entries(o).flatMap(([name, value]) =>
      value === true ? [`--${name}`] : [`--${name}`, value],
    );
    const result = await buildTemplate(args);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const dir = resolve(o.job ?? 'artifacts/todo-job');
  let result;
  if (command === 'plan') {
    const defaults = await planDefaults(o);
    try {
      await access(defaults.modelsFile);
    } catch {
      assert.fail(
        'Existing Pi models.json was not found. Set PI_MODELS_FILE in .env to your preset file path and reload direnv.',
      );
    }
    result = await planJob({
      jobDir: dir,
      repository: defaults.repository,
      baseSha: defaults.baseSha,
      baseBranch: o.base,
      modelsFile: defaults.modelsFile,
      model: process.env[o['model-env'] ?? 'GHAI_PI_PRIMARY_MODEL'],
      decisionModel: process.env.GHAI_DECISION_MODEL,
      baseUrl: process.env[o['base-url-env'] ?? 'GHAI_BASE_URL'],
      configurationNames: {
        model: o['model-env'] ?? 'GHAI_PI_PRIMARY_MODEL',
        baseUrl: o['base-url-env'] ?? 'GHAI_BASE_URL',
      },
      product: o.product,
      technical: o.technical,
      manifest: o.manifest,
      environment: {
        e2b: o['e2b-env'] ?? 'E2B_API_KEY',
        ghai: o['ghai-env'] ?? 'GHAI_API_KEY',
        context7: o['context7-env'] ?? 'CONTEXT7_API_KEY',
        github: o['github-env'] ?? 'GH_TOKEN',
      },
    });
    console.log(
      JSON.stringify(
        {
          status: 'prepared',
          job: dir,
          repository: result.repository,
          baseSha: result.baseSha,
          modelVariable: result.configurationNames.model,
          baseUrlVariable: result.configurationNames.baseUrl,
          inputHashes: result.inputs,
          allowedPaths: result.allowedPaths,
          environmentNames: result.environment,
          budget: result.budget,
          publication: 'Separate explicit publish command; draft PR only',
          warning:
            'No cloud request made. Live execution incurs E2B/model charges; limits are not a monetary cap.',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'run')
    result = await runJob(dir, {
      live: o.live,
      buildFile: o['template-build'] ?? 'artifacts/e2b-template-build.json',
    });
  if (command === 'cancel') result = await cancelJob(dir, { live: o.live });
  if (command === 'publish') result = await publishJob(dir, { live: o.live });
  if (command === 'status')
    result = (await loadJob(dir, { verifyInputs: false })).state;
  console.log(JSON.stringify(result, null, 2));
  if (
    ['blocked', 'failed', 'unknown', 'publication_unknown'].includes(
      result.status,
    ) ||
    result.cleanup === 'unconfirmed'
  )
    process.exitCode = 1;
}
if (process.argv[1]?.endsWith('/cli.mjs'))
  main().catch((error) => {
    console.error(
      error?.code === 'ERR_ASSERTION'
        ? error.message
        : 'Operation stopped. Check inputs and recorded job status; raw diagnostics are withheld to protect credentials.',
    );
    process.exitCode = 1;
  });
