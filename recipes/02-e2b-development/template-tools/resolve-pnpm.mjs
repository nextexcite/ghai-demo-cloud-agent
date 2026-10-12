import { createRequire } from 'node:module';
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PNPM_VERSION = '12.11.2';

/**
 * Resolve the integrity-locked native dependency without running install.js or
 * the pnpm wrapper's fallback downloader. The mise-generated pnpm 12 shim would
 * otherwise pass its shebang-less shell placeholder to Node.
 * @param {string} installDirectory
 */
export function resolvePinnedPnpm(installDirectory) {
  const root = realpathSync(installDirectory);
  /** @param {string} filename */
  const contained = (filename) => {
    const actual = realpathSync(filename);
    if (!actual.startsWith(`${root}${sep}`)) {
      throw new Error(
        'The pnpm package must remain inside its locked installation.',
      );
    }
    return actual;
  };
  const wrapperPath = contained(join(root, 'node_modules/pnpm/package.json'));
  const wrapper = JSON.parse(readFileSync(wrapperPath, 'utf8'));
  if (
    wrapper.name !== 'pnpm' ||
    wrapper.version !== PNPM_VERSION ||
    wrapper.optionalDependencies?.['@pnpm/exe.linux-x64'] !== PNPM_VERSION
  ) {
    throw new Error('Unexpected pnpm wrapper or Linux x64 dependency version.');
  }
  const manifestPath = contained(
    createRequire(wrapperPath).resolve('@pnpm/exe.linux-x64/package.json'),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.name !== '@pnpm/exe.linux-x64' ||
    manifest.version !== PNPM_VERSION
  ) {
    throw new Error('Unexpected pnpm native package version.');
  }
  const binary = contained(join(dirname(manifestPath), 'pnpm'));
  const info = statSync(binary);
  if (!info.isFile() || !(info.mode & 0o111)) {
    throw new Error('The locked pnpm native binary is not executable.');
  }
  const handle = openSync(binary, 'r');
  try {
    const magic = Buffer.alloc(4);
    readSync(handle, magic, 0, magic.length, 0);
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('The locked pnpm executable is not an ELF binary.');
    }
  } finally {
    closeSync(handle);
  }
  return binary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw new Error('Pass exactly one pnpm installation directory.');
  process.stdout.write(`${resolvePinnedPnpm(process.argv[2])}\n`);
}
