import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  limits,
  primary,
  fallback,
  models,
  systemPrompt,
  sha256,
  isSha,
  validateModels,
  readBounded,
} from './policy.mjs';
import {
  createPrivate,
  replacePrivate,
  ledger,
  resultPath,
} from './storage.mjs';
import { renderReview, parseReview } from './review-format.mjs';

/** @typedef {{repository:string, workflowSha:string, fixture?:boolean, fixtureSha256?:string, pr?:number, base?:string, head?:string, diffSha256?:string, diffBytes?:number}} Provenance */
/** @param {string} diff @param {Provenance} meta */
export function buildPrompt(diff, meta) {
  assert(diff.trim() && Buffer.byteLength(diff) <= limits.maxDiffBytes);
  assert(/^[\w.-]+\/[\w.-]+$/.test(meta.repository));
  assert(isSha(meta.workflowSha));
  const target = meta.fixture
    ? 'Synthetic fixture; not a repository PR.'
    : `PR #${meta.pr}; base ${meta.base}; head ${meta.head}.`;
  if (!meta.fixture)
    assert(
      Number.isSafeInteger(meta.pr) &&
        Number(meta.pr) > 0 &&
        isSha(meta.base) &&
        isSha(meta.head),
    );
  // Reject unsupported/malformed diff formats before any inference allowance is spent.
  parseReview(
    JSON.stringify({
      summary: 'Preparation check',
      verdict: 'OK',
      findings: [],
    }),
    diff,
  );
  // JSON encoding keeps patch delimiter lookalikes and shell syntax literal data.
  return `${systemPrompt}\nRepository: ${meta.repository}\n${target}\nUNTRUSTED_PATCH_JSON:\n${JSON.stringify(diff)}`;
}
/** @param {string} root @param {string} prompt @param {Provenance} provenance @param {NodeJS.ProcessEnv} env @param {string} diff */
export function configure(
  root,
  prompt,
  provenance,
  env = process.env,
  diff = '',
) {
  const configuration = validateModels(env);
  mkdirSync(root, { mode: 0o700 });
  for (const path of ['home', 'agent', 'workspace'])
    mkdirSync(join(root, path), { mode: 0o700 });
  createPrivate(join(root, 'agent', 'auth.json'), {});
  createPrivate(join(root, 'agent', 'models.json'), { providers: {} });
  createPrivate(join(root, 'agent', 'settings.json'), {
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    cacheWarming: 'off',
    packages: [],
    extensions: [],
    skills: [],
    promptTemplates: [],
  });
  createPrivate(join(root, 'prompt.txt'), prompt);
  createPrivate(join(root, 'diff.txt'), diff);
  createPrivate(join(root, 'configuration.json'), configuration);
  createPrivate(join(root, 'provenance.json'), provenance);
  createPrivate(join(root, 'attempts.jsonl'), '');
  createPrivate(join(root, 'plan.json'), {
    provider: 'ghai',
    api: 'openai-responses',
    primary,
    fallback,
    ...limits,
    fallbackPolicy:
      'Only an explicit pre-execution model rejection (HTTP 400/404/422 and allowlisted code). Unknown outcomes stop.',
    billing:
      'Actual billing is unknown. Client request/token bounds are not a dollar cap or a gateway account limit.',
  });
}
/** @param {NodeJS.ProcessEnv} env @param {typeof fetch} fetchImpl */
export async function prepare(env = process.env, fetchImpl = fetch) {
  validateModels(env);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(env.GHAI_ALLOW_INFERENCE, 'true');
  const repository = env.GITHUB_REPOSITORY ?? '';
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository));
  assert(isSha(env.GITHUB_SHA));
  assert(/^\d+$/.test(env.GITHUB_RUN_ID ?? ''));
  assert(env.RUNNER_TEMP && env.GITHUB_OUTPUT);
  assert(env.GHAI_PR === 'verify' || /^[1-9]\d{0,8}$/.test(env.GHAI_PR ?? ''));
  /** @type {Provenance} */
  let meta = {
    repository,
    workflowSha: /** @type {string} */ (env.GITHUB_SHA),
  };
  let diff;
  if (env.GHAI_PR === 'verify') {
    diff = readFileSync(
      new URL('../../fixtures/review.diff', import.meta.url),
      'utf8',
    );
    meta = { ...meta, fixture: true, fixtureSha256: sha256(diff) };
  } else {
    assert(env.GITHUB_TOKEN);
    const api = `https://api.github.com/repos/${repository}`;
    const headers = {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
    const options = {
      headers,
      redirect: /** @type {const} */ ('error'),
      signal: AbortSignal.timeout(30000),
    };
    const response = await fetchImpl(`${api}/pulls/${env.GHAI_PR}`, options);
    assert(response.ok);
    const pr = JSON.parse(await readBounded(response, 131072));
    assert.equal(pr.state, 'open');
    assert.equal(pr.base?.repo?.full_name, repository);
    assert(isSha(pr.base?.sha) && isSha(pr.head?.sha));
    meta = {
      ...meta,
      pr: Number(env.GHAI_PR),
      base: pr.base.sha,
      head: pr.head.sha,
    };
    const patch = await fetchImpl(
      `${api}/compare/${meta.base}...${meta.head}`,
      {
        ...options,
        headers: { ...headers, accept: 'application/vnd.github.diff' },
      },
    );
    assert(patch.ok);
    diff = await readBounded(patch, limits.maxDiffBytes);
  }
  meta = {
    ...meta,
    diffBytes: Buffer.byteLength(diff),
    diffSha256: sha256(diff),
  };
  const prompt = buildPrompt(diff, meta);
  const root = join(
    resolve(env.RUNNER_TEMP),
    `ghai-review-${env.GITHUB_RUN_ID}`,
  );
  assert(!/[\r\n]/.test(root));
  configure(root, prompt, meta, env, diff);
  // The action receives only a fixed instruction, never the patch in a logged input.
  writeFileSync(env.GITHUB_OUTPUT, `root=${root}\n`, {
    flag: 'a',
    mode: 0o600,
  });
  return root;
}
/** @param {string} root @param {string} model */
export function decision(root, model) {
  try {
    assert(models.includes(model));
    const rows = ledger(root);
    if (rows.some((row) => row.type === 'policy-stop')) return 'stop';
    const reservations = rows.filter((row) => row.type === 'reservation');
    if (
      reservations.length > limits.maxAttempts ||
      reservations.filter((row) => row.model === model).length !== 1
    )
      return 'stop';
    const result = JSON.parse(readFileSync(resultPath(root, model), 'utf8'));
    if (result.model !== model) return 'stop';
    if (
      result.state === 'completed' &&
      result.terminalEvent === 'response.completed' &&
      result.streamed === true &&
      rows.some((row) => row.type === 'completed' && row.model === model)
    )
      return 'completed';
    if (
      model === primary &&
      reservations.length === 1 &&
      result.state === 'rejected-before-execution' &&
      rows.some(
        (row) =>
          row.type === 'rejected-before-execution' && row.model === primary,
      )
    )
      return 'fallback';
  } catch {
    /* Missing, truncated, or inconsistent accounting is terminal. */
  }
  return 'stop';
}
/** Only the explicit live CLI path supplies summaryPath; unit tests never inherit it.
 * @param {string} root @param {{summaryPath?:string}} options
 */
export function finish(root, options = {}) {
  const chosen = models.find((model) => decision(root, model) === 'completed');
  const provenance = JSON.parse(
    readFileSync(join(root, 'provenance.json'), 'utf8'),
  );
  const rows = ledger(root);
  const result = chosen
    ? JSON.parse(readFileSync(resultPath(root, chosen), 'utf8'))
    : null;
  const report = {
    ...provenance,
    completed: Boolean(chosen),
    model: chosen ?? null,
    state: chosen ? 'completed' : 'stopped',
    usage: result?.usage ?? null,
    actualBillingUsd: null,
    reservations: rows.filter((row) => row.type === 'reservation').length,
    budget: limits,
    note: 'No automatic replay. Unknown, interrupted, failed and rejected attempts remain accounted. Review is untrusted model output.',
  };
  replacePrivate(join(root, 'report.json'), report);
  const content = chosen
    ? renderReview(result.review, provenance)
    : '# Review unavailable\n\nNo verified structured review was produced. Inspect the sanitized accounting before authorizing another attempt.\n';
  const review = `${content}\n<details>\n<summary>Execution accounting</summary>\n\nRequests reserved: ${report.reservations}. Completed output tokens: ${result?.usage?.output ?? 'unknown'}. Actual billing: unknown.\n\nThis is a bounded diff-only review. No PR code was executed.\n</details>\n`;
  replacePrivate(join(root, 'review.md'), review);
  if (options.summaryPath)
    writeFileSync(options.summaryPath, review, { flag: 'w' });
  return Boolean(chosen);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [command, root, model] = process.argv.slice(2);
    if (command === 'prepare') await prepare();
    else if (command === 'decide') {
      assert(root && model && process.env.GITHUB_OUTPUT);
      writeFileSync(
        process.env.GITHUB_OUTPUT,
        `next=${decision(root, model)}\n`,
        { flag: 'a' },
      );
    } else if (command === 'finish') {
      assert(root);
      if (!finish(root, { summaryPath: process.env.GITHUB_STEP_SUMMARY }))
        process.exitCode = 1;
    } else throw new Error('Unknown command');
  } catch {
    console.error(
      'Bounded review stopped. Details withheld; inspect sanitized artifacts. No automatic replay.',
    );
    process.exitCode = 1;
  }
}
