import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadJob,
  hash,
  readSmall,
  writeJson,
  resolveSecrets,
  reserveAction,
} from './core.mjs';
const exec = promisify(execFile);
const safeGitEnv = {
  PATH: process.env.PATH,
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'https',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'credential.helper',
  GIT_CONFIG_VALUE_1: '',
};
export function validateOutputPath(path, allowed = ['examples/todo-app/']) {
  assert(
    typeof path === 'string' &&
      path.length < 500 &&
      /^[A-Za-z0-9_./@+-]+$/.test(path),
    'Unexpected output path',
  );
  assert(
    !path.startsWith('/') &&
      !path
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            part.toLowerCase() === '.git',
        ),
    'Unsafe output path',
  );
  assert(
    allowed.some((prefix) => path.startsWith(prefix)),
    'Output outside approved scope',
  );
  assert(
    !/(^|\/)(\.env(?:\..*)?|auth\.json|models\.json|mcp-auth\.json|.*\.(?:pem|key)|\.npmrc|\.pnpmfile\.(?:js|cjs))$/i.test(
      path,
    ),
    'Credential/config output is forbidden',
  );
  assert(
    !path.includes('/node_modules/') && !path.includes('/.pi/'),
    'Generated dependency/Pi state is forbidden',
  );
}
export function scanSecrets(bytes, secrets = []) {
  const text = bytes.toString('utf8');
  for (const secret of secrets)
    if (secret) assert(!text.includes(secret), 'Credential found in output');
  assert(
    !/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9_.-]{20,}/.test(
      text,
    ),
    'Potential credential found in output',
  );
}
export async function inspectPatch(dir, job, patch, { prepareBase } = {}) {
  const work = join(dir, 'publication-worktree');
  await mkdir(work, { mode: 0o700 });
  const git = async (...args) =>
    (
      await exec('git', args, {
        cwd: work,
        env: safeGitEnv,
        encoding: 'buffer',
        maxBuffer: 5_000_000,
      })
    ).stdout;
  try {
    await git('init', '--quiet');
    if (prepareBase) await prepareBase(work);
    else
      await git(
        'fetch',
        '--no-tags',
        '--depth=1',
        `https://github.com/${job.repository}.git`,
        job.baseSha,
      );
    await git('checkout', '--detach', job.baseSha);
    const stats = (
      await git('apply', '--numstat', '-z', join(dir, 'changes.patch'))
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    assert(stats.length > 0 && stats.length <= 250, 'Invalid file count');
    for (const row of stats)
      validateOutputPath(row.split('\t').slice(2).join('\t'), job.allowedPaths);
    await git(
      'apply',
      '--check',
      '--index',
      '--binary',
      join(dir, 'changes.patch'),
    );
    await git('apply', '--index', '--binary', join(dir, 'changes.patch'));
    const changes = (
      await git('diff', '--cached', '--name-status', '-z', '--no-renames')
    )
      .toString('utf8')
      .split('\0');
    const files = [];
    let size = 0;
    for (let i = 0; i < changes.length - 1; i += 2) {
      const [status, path] = [changes[i], changes[i + 1]];
      assert(['A', 'M', 'D'].includes(status));
      validateOutputPath(path, job.allowedPaths);
      if (status === 'D') {
        files.push({ path, sha: null, mode: '100644', type: 'blob' });
        continue;
      }
      const entry = (await git('ls-files', '--stage', '--', path)).toString(
        'utf8',
      );
      const mode = entry.split(' ')[0];
      assert(
        ['100644', '100755'].includes(mode),
        'Symlinks/submodules are forbidden',
      );
      const content = await git('show', `:${path}`);
      size += content.length;
      assert(size <= 4_000_000, 'Output exceeds artifact limit');
      files.push({
        path,
        mode,
        type: 'blob',
        content: content.toString('base64'),
      });
    }
    assert(
      hash(await readFile(join(dir, 'changes.patch'))) === hash(patch),
      'Patch changed during validation',
    );
    return files;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
export class GitHubPublisher {
  constructor(token, request = fetch) {
    this.token = token;
    this.request = request;
  }
  async api(path, method = 'GET', body) {
    const response = await this.request(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert(
      response.ok,
      'GitHub publication request failed; outcome may be unknown',
    );
    return response.json();
  }
  async publish(job, files, record) {
    const prefix = `/repos/${job.repository}`;
    const repo = await this.api(prefix);
    assert.equal(repo.private, false);
    assert.equal(repo.full_name.toLowerCase(), job.repository.toLowerCase());
    const base = await this.api(`${prefix}/git/commits/${job.baseSha}`);
    const tree = [];
    for (const file of files) {
      const entry = {
        path: file.path,
        mode: file.mode,
        type: 'blob',
        sha: null,
      };
      if (file.content !== undefined)
        entry.sha = (
          await this.api(`${prefix}/git/blobs`, 'POST', {
            content: file.content,
            encoding: 'base64',
          })
        ).sha;
      tree.push(entry);
    }
    const createdTree = await this.api(`${prefix}/git/trees`, 'POST', {
      base_tree: base.tree.sha,
      tree,
    });
    const commit = await this.api(`${prefix}/git/commits`, 'POST', {
      message: `Implement local todo app (job ${job.jobId})`,
      tree: createdTree.sha,
      parents: [job.baseSha],
    });
    await record({ commit: commit.sha }); // Persist before an externally visible write.
    await this.api(`${prefix}/git/refs`, 'POST', {
      ref: `refs/heads/${job.branch}`,
      sha: commit.sha,
    });
    await record({ branchCreated: true });
    const pr = await this.api(`${prefix}/pulls`, 'POST', {
      title: 'Implement local TanStack todo app',
      head: job.branch,
      base: job.baseBranch,
      draft: true,
      body: `Spec-first E2B implementation.\n\nJob: ${job.jobId}\nBase: ${job.baseSha}\nHead: ${commit.sha}\nProduct spec SHA256: ${job.inputs['product.md']}\nTechnical spec SHA256: ${job.inputs['technical.md']}\n\nSandbox checks: lint, typecheck, test, build passed. Live behavior and production deployment are not qualified. Review generated code and test coverage before merging. No deployment or auto-merge was requested.`,
    });
    assert.equal(pr.draft, true);
    assert.equal(pr.head.sha, commit.sha);
    return {
      commit: commit.sha,
      branch: job.branch,
      prUrl: pr.html_url,
      prNumber: pr.number,
    };
  }
}
export async function publishJob(
  dir,
  { live = false, env = process.env, publisher, inspect = inspectPatch } = {},
) {
  assert(live, 'GitHub branch and draft PR publication requires --live');
  const { job, state } = await loadJob(dir);
  assert.equal(
    state.status,
    'ready_to_publish',
    'Publication cannot be replayed; inspect unknown outcomes manually',
  );
  const result = JSON.parse(await readSmall(join(dir, 'result.json')));
  const patch = await readFile(join(dir, 'changes.patch'));
  assert.equal(hash(patch), state.patchSha256);
  assert.equal(hash(patch), result.patchSha256);
  assert.equal(
    result.agent?.patchSha256,
    result.patchSha256,
    'QA candidate mismatch',
  );
  assert.equal(
    result.agent?.rounds?.at(-1)?.action,
    'ready_for_review',
    'QA decision missing',
  );
  assert.deepEqual(
    result.verification,
    ['lint', 'typecheck', 'test', 'build'].map((check) => ({
      check,
      status: 'passed',
    })),
  );
  const { github } = resolveSecrets(job, env, ['github']);
  const knownSecrets = [
    ...Object.values(job.environment)
      .map((name) => env[name])
      .filter(Boolean),
    job.provider.baseUrl,
    new URL(job.provider.baseUrl).hostname,
    job.model.id,
    job.model.name,
  ].filter(Boolean);
  scanSecrets(patch, knownSecrets);
  const files = await inspect(dir, job, patch);
  for (const file of files)
    if (file.content)
      scanSecrets(Buffer.from(file.content, 'base64'), knownSecrets);
  await reserveAction(dir, 'publish', job.jobId);
  state.status = 'publishing';
  await writeJson(join(dir, 'state.json'), state);
  try {
    const client = publisher ?? new GitHubPublisher(github);
    const published = await client.publish(job, files, async (updates) => {
      Object.assign(state, updates);
      await writeJson(join(dir, 'state.json'), state);
    });
    Object.assign(state, published, { status: 'completed' });
  } catch {
    state.status = 'publication_unknown';
    state.error =
      'Inspect the recorded branch/commit on GitHub before further publication; no automatic retry';
  }
  await writeJson(join(dir, 'state.json'), state);
  return state;
}
