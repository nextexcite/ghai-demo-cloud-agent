#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { planJob, runJob, loadJob, cancelJob } from './core.mjs';
import { publishJob } from './publish.mjs';
const exec = promisify(execFile);
const usage = `Spec-first E2B development (offline by default)
  doctor
  plan --models-file PATH --model-env GHAI_PI_PRIMARY_MODEL --base-url-env GHAI_PI_BASE_URL --repo OWNER/REPO --base-sha SHA
       --e2b-env NAME --context7-env NAME --github-env NAME --job DIRECTORY
       [--ghai-env GHAI_API_KEY] [--exa-env NAME] [--base main]
       [--product PATH] [--technical PATH] [--manifest PATH]
  run --job DIRECTORY --template-build PATH --live
  status --job DIRECTORY
  cancel --job DIRECTORY --live
  publish --job DIRECTORY --live
No credentials in arguments. Live build/run/publish are separate explicit actions.
`;
export function parseArgs(args) {
  const command = args.shift();
  const options = {};
  const accepted = {
    doctor: [],
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
      'exa-env',
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
  assert(typeof o.job === 'string', '--job DIRECTORY is required');
  const dir = resolve(o.job);
  let result;
  if (command === 'plan') {
    assert(
      typeof o['models-file'] === 'string',
      '--models-file PATH is required',
    );
    result = await planJob({
      jobDir: dir,
      repository: o.repo,
      baseSha: o['base-sha'],
      baseBranch: o.base,
      modelsFile: resolve(o['models-file']),
      model: process.env[o['model-env'] ?? 'GHAI_PI_PRIMARY_MODEL'],
      baseUrl: process.env[o['base-url-env'] ?? 'GHAI_PI_BASE_URL'],
      configurationNames: {
        model: o['model-env'] ?? 'GHAI_PI_PRIMARY_MODEL',
        baseUrl: o['base-url-env'] ?? 'GHAI_PI_BASE_URL',
      },
      product: o.product,
      technical: o.technical,
      manifest: o.manifest,
      environment: {
        e2b: o['e2b-env'],
        ghai: o['ghai-env'] ?? 'GHAI_API_KEY',
        context7: o['context7-env'],
        github: o['github-env'],
        ...(o['exa-env'] ? { exa: o['exa-env'] } : {}),
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
      buildFile: o['template-build'],
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
