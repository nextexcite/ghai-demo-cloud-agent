import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Template } from 'e2b';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const toolSources = 'recipes/02-e2b-development/template-tools';
export const TOOLCHAIN_ROOT = '/opt/ghai-delegation';
export const TOOL_VERSIONS = Object.freeze({
  node: '24.21.0',
  pnpm: '12.11.2',
  pi: '1.1.0',
  mise: '2026.10.8',
});
export const MISE_SHA256 =
  'c72477ae6c3a8e7d817a322f43da70e4643e75ee5c21265f1c19c894273b7428';

// Only these files are uploaded, never a repository directory, .env, or .pi.
export const TEMPLATE_FILES = Object.freeze([
  ['package.json', `${TOOLCHAIN_ROOT}/packages/package.json`],
  ['pnpm-lock.yaml', `${TOOLCHAIN_ROOT}/packages/pnpm-lock.yaml`],
  [
    `${toolSources}/bootstrap.sh`,
    `${TOOLCHAIN_ROOT}/template-tools/bootstrap.sh`,
  ],
  [
    `${toolSources}/resolve-pnpm.mjs`,
    `${TOOLCHAIN_ROOT}/template-tools/resolve-pnpm.mjs`,
  ],
  [`${toolSources}/mise.toml`, `${TOOLCHAIN_ROOT}/template-tools/mise.toml`],
  [`${toolSources}/mise.lock`, `${TOOLCHAIN_ROOT}/template-tools/mise.lock`],
  ...['package.json', 'aube-lock.yaml'].map((filename) => [
    `${toolSources}/.mise/locks/npm-pnpm/12.11.2/${filename}`,
    `${TOOLCHAIN_ROOT}/template-tools/.mise/locks/npm-pnpm/12.11.2/${filename}`,
  ]),
]);

/** Construct a template locally. This function does not build or provision. */
export function createTemplate({ fileContextPath = repositoryRoot } = {}) {
  let template = Template({ fileContextPath })
    // This official alias is mutable. The build descriptor does not pretend
    // that the base OS or base git version is independently reproducible.
    .fromTemplate('pi')
    .setUser('root')
    .runCmd(
      `mkdir -p ${TOOLCHAIN_ROOT}/packages ${TOOLCHAIN_ROOT}/template-tools/.mise/locks/npm-pnpm/12.11.2`,
    );
  for (const [source, destination] of TEMPLATE_FILES) {
    template = template.copy(source, destination, {
      user: 'root',
      mode: 0o644,
    });
  }
  return template
    .runCmd(
      `bash ${TOOLCHAIN_ROOT}/template-tools/bootstrap.sh --sandbox-template-build`,
    )
    .setEnvs({
      PATH: `${TOOLCHAIN_ROOT}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      MISE_DATA_DIR: `${TOOLCHAIN_ROOT}/mise/data`,
      MISE_CONFIG_DIR: '/home/user/.ghai-mise/config',
      MISE_CACHE_DIR: '/home/user/.ghai-mise/cache',
      MISE_STATE_DIR: '/home/user/.ghai-mise/state',
      MISE_SYSTEM_CONFIG_DIR: `${TOOLCHAIN_ROOT}/mise/system`,
      MISE_AUTO_INSTALL: 'false',
      PI_OFFLINE: '1',
    })
    .setUser('user')
    .setWorkdir('/home/user');
  // No Pi start command: credentials, specs and runner arrive only after create.
}

/**
 * Validate opt-in before any E2B request or credential lookup.
 * @param {string[]} args
 */
export function parseBuildArguments(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      live: { type: 'boolean', default: false },
      name: { type: 'string' },
      'api-key-env': { type: 'string' },
      out: { type: 'string', default: 'artifacts/e2b-template-build.json' },
    },
  });
  if (!values.live) {
    throw new Error(
      'Template builds require explicit --live; no E2B request was made.',
    );
  }
  if (!values.name || !/^[a-z][a-z0-9-]{2,62}$/.test(values.name)) {
    throw new Error(
      '--name must be an explicit 3–63 character lowercase template name.',
    );
  }
  if (
    !values['api-key-env'] ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(values['api-key-env'])
  ) {
    throw new Error(
      '--api-key-env must name the existing E2B credential environment variable.',
    );
  }
  return {
    name: values.name,
    apiKeyEnv: values['api-key-env'],
    outputPath: resolve(values.out),
  };
}

/** Snapshot the allowlisted files so descriptor hashes describe uploaded bytes. */
async function stageSources() {
  const directory = await mkdtemp(join(tmpdir(), 'ghai-e2b-template-'));
  /** @type {Record<string, string>} */
  const hashes = {};
  try {
    for (const [source] of TEMPLATE_FILES) {
      const sourcePath = join(repositoryRoot, source);
      const info = await lstat(sourcePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2_097_152) {
        throw new Error('Template input must be a bounded regular file.');
      }
      const bytes = await readFile(sourcePath);
      const target = join(directory, source);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o400, flag: 'wx' });
      hashes[source] = createHash('sha256').update(bytes).digest('hex');
    }
    const packageJson = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8'),
    );
    if (
      packageJson.packageManager !== `pnpm@${TOOL_VERSIONS.pnpm}` ||
      packageJson.devDependencies?.['@earendil-works/pi-coding-agent'] !==
        TOOL_VERSIONS.pi ||
      packageJson.devDependencies?.e2b !== '2.55.0'
    ) {
      throw new Error(
        'Template dependency pins differ from the reviewed versions.',
      );
    }
    return { directory, hashes };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Explicit live entrypoint. Not called by imports, setup, or offline checks.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} environment
 * @param {typeof Template.build} buildOperation Explicit injection for offline tests.
 */
export async function buildTemplate(
  args,
  environment = process.env,
  buildOperation = Template.build,
) {
  const options = parseBuildArguments(args);
  const apiKey = environment[options.apiKeyEnv];
  if (!apiKey?.trim()) {
    throw new Error(
      'The selected E2B credential environment variable is empty.',
    );
  }
  const staged = await stageSources();
  try {
    await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o700 });
    // Create-only reservation: an interrupted or failed build cannot be blindly
    // retried using the same descriptor. Inspect the E2B dashboard first.
    const record = await open(options.outputPath, 'wx', 0o600);
    const descriptor = {
      schemaVersion: 1,
      status: 'build-outcome-unknown',
      name: options.name,
      templateId: null,
      buildId: null,
      base: 'pi',
      baseBuildId: null,
      baseIsMutable: true,
      baseNote:
        'The official pi alias and inherited OS/git are not independently pinned.',
      sdk: { package: 'e2b', version: '2.55.0' },
      toolchain: {
        ...TOOL_VERSIONS,
        miseSha256: MISE_SHA256,
        platform: 'linux-x64',
      },
      installedVersionReport: `${TOOLCHAIN_ROOT}/toolchain.json`,
      sourceSha256: staged.hashes,
      templateDefinitionSha256: createHash('sha256')
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest('hex'),
      requestedAt: new Date().toISOString(),
      completedAt: null,
    };
    try {
      await record.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`);
      await record.sync();
      let build;
      try {
        build = await buildOperation(
          createTemplate({ fileContextPath: staged.directory }),
          options.name,
          {
            apiKey,
            domain: 'e2b.app',
            apiUrl: 'https://api.e2b.app',
            sandboxUrl: 'https://sandbox.e2b.app',
            debug: false,
            retries: 0,
            cpuCount: 2,
            memoryMB: 2048,
          },
        );
      } catch {
        // Do not persist or print SDK errors that might contain credentials.
        throw new Error(
          'E2B build did not return a verified success. Inspect the dashboard and the reserved descriptor before another build.',
        );
      }
      if (
        ![build.templateId, build.buildId].every(
          (value) =>
            typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value),
        )
      ) {
        throw new Error(
          'E2B build returned no immutable build identity; the descriptor remains unknown.',
        );
      }
      Object.assign(descriptor, {
        status: 'ready',
        templateId: build.templateId,
        buildId: build.buildId,
        completedAt: new Date().toISOString(),
      });
      // Replace only after a complete local write; interruption preserves the
      // unknown reservation rather than a truncated success descriptor.
      const completedPath = `${options.outputPath}.completed`;
      await writeFile(
        completedPath,
        `${JSON.stringify(descriptor, null, 2)}\n`,
        {
          mode: 0o600,
          flag: 'wx',
        },
      );
      const completed = await open(completedPath, 'r');
      await completed.sync();
      await completed.close();
      await rename(completedPath, options.outputPath);
      await chmod(options.outputPath, 0o600);
      return descriptor;
    } finally {
      await record.close();
    }
  } finally {
    await rm(staged.directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  buildTemplate(process.argv.slice(2)).then(
    (descriptor) =>
      process.stdout.write(`${JSON.stringify(descriptor, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
