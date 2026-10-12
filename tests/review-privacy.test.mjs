import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, sse, events, reviewText, configuration } from './helpers.mjs';
import { createRunner } from '../ops/ci/transport.mjs';
import { finish, buildPrompt } from '../ops/ci/review.mjs';
import { validateModels, primary } from '../ops/ci/policy.mjs';
import { metadata } from './helpers.mjs';

test('connection/model configuration is required and canonical, with no defaults', () => {
  assert.throws(() => validateModels({}));
  for (const key of Object.keys(configuration))
    assert.throws(() => validateModels({ ...configuration, [key]: '' }));
  for (const value of [
    'http://gateway.example.invalid/v1',
    'https://user:pass@gateway.example.invalid/v1',
    'https://gateway.example.invalid/v1?x=1',
    'https://gateway.example.invalid/v1#x',
    'https://gateway.example.invalid/v1/',
    'https://gateway.example.invalid/v2',
  ])
    assert.throws(() =>
      validateModels({ ...configuration, GHAI_BASE_URL: value }),
    );
  assert.throws(() =>
    validateModels({
      ...configuration,
      GHAI_PI_FALLBACK_MODEL: configuration.GHAI_PI_PRIMARY_MODEL,
    }),
  );
  assert.equal(
    validateModels(configuration).endpoint,
    configuration.GHAI_BASE_URL + '/responses',
  );
});

test('unsupported patches fail preparation before a request can be spent', () => {
  for (const diff of [
    'diff --git a/x b/x\nBinary files differ\n',
    'diff --git a/x b/x\n+malformed',
  ])
    assert.throws(() => buildPrompt(diff, metadata));
});

test('artifacts and model-visible review exclude configured endpoint/model identities', async () => {
  const f = fixture();
  try {
    const text = reviewText(
      `References ${configuration.GHAI_PI_PRIMARY_MODEL}, ${configuration.GHAI_PI_FALLBACK_MODEL}, ${configuration.GHAI_BASE_URL} and gateway.example.invalid are irrelevant to this diff.`,
    );
    const runner = createRunner(f.env(), async () => sse(events(text)));
    const result = await runner.run();
    assert.equal(result.state, 'completed');
    assert.equal(finish(f.root), true);
    for (const filename of [
      'plan.json',
      'provenance.json',
      'attempts.jsonl',
      'report.json',
      'review.md',
    ]) {
      const body = readFileSync(join(f.root, filename), 'utf8');
      for (const hidden of Object.values(configuration))
        assert(!body.includes(hidden), filename);
      assert(!body.includes('gateway.example.invalid'), filename);
    }
    assert.equal(
      JSON.parse(readFileSync(join(f.root, 'report.json'), 'utf8')).model,
      primary,
    );
    assert(!result.text.includes(configuration.GHAI_PI_PRIMARY_MODEL));
  } finally {
    f.cleanup();
  }
});

test('public output redacts case variants of configured endpoint and model identities', async () => {
  const f = fixture();
  try {
    const text = reviewText(
      `${configuration.GHAI_BASE_URL.toUpperCase()} ${configuration.GHAI_PI_PRIMARY_MODEL.toUpperCase()} ${configuration.GHAI_PI_FALLBACK_MODEL.toUpperCase()} GATEWAY.EXAMPLE.INVALID`,
    );
    const result = await createRunner(f.env(), async () =>
      sse(events(text)),
    ).run();
    assert.equal(result.state, 'completed');
    assert.equal(finish(f.root), true);
    for (const body of [
      JSON.stringify(result),
      readFileSync(join(f.root, 'review.md'), 'utf8'),
      readFileSync(join(f.root, 'report.json'), 'utf8'),
    ]) {
      for (const identity of [
        ...Object.values(configuration),
        'gateway.example.invalid',
      ])
        assert(!body.toLowerCase().includes(identity.toLowerCase()));
    }
  } finally {
    f.cleanup();
  }
});

test('decoded review fields redact delivered credentials containing JSON and regex metacharacters', async () => {
  const f = fixture();
  const credential = 'fixture"quoted\\credential.*+[key]';
  try {
    const text = JSON.stringify({
      summary: `Untrusted reference ${credential}`,
      verdict: 'BLOCK',
      findings: [
        {
          path: 'example.mjs',
          line: 1,
          severity: 'HIGH',
          explanation: `Untrusted explanation ${credential}`,
          fix: `Untrusted fix ${credential}`,
        },
      ],
    });
    const result = await createRunner(
      { ...f.env(), GHAI_API_KEY: credential },
      async () => sse(events(text)),
    ).run();
    assert.equal(result.state, 'completed');
    assert.equal(finish(f.root), true);
    for (const value of [
      result.review.summary,
      result.review.findings[0].explanation,
      result.review.findings[0].fix,
    ]) {
      assert(!value.includes(credential));
      assert(value.includes('[redacted]'));
    }
    for (const name of ['review.md', 'report.json']) {
      const output = readFileSync(join(f.root, name), 'utf8');
      assert(!output.includes('quoted'));
      assert(!output.includes('credential'));
    }
  } finally {
    f.cleanup();
  }
});

test('tests never write inherited GitHub summary; live summary is one clear structured result', async () => {
  const f = fixture();
  const prior = process.env.GITHUB_STEP_SUMMARY;
  const path = join(f.dir, 'summary.md');
  writeFileSync(path, 'existing summary');
  process.env.GITHUB_STEP_SUMMARY = path;
  try {
    const runner = createRunner(f.env(), async () => sse());
    await runner.run();
    finish(f.root);
    finish(f.root);
    assert.equal(readFileSync(path, 'utf8'), 'existing summary');
    finish(f.root, { summaryPath: path });
    finish(f.root, { summaryPath: path });
    const summary = readFileSync(path, 'utf8');
    assert.equal((summary.match(/^# /gm) ?? []).length, 1);
    assert(summary.includes('OK'));
    assert(summary.includes('Execution accounting'));
    assert(summary.includes('example'));
    assert(!summary.includes('verified completed stream'));
  } finally {
    if (prior === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = prior;
    f.cleanup();
  }
});

test('frozen configuration changes fail before dispatch', () => {
  const f = fixture();
  try {
    assert.throws(() =>
      createRunner({
        ...f.env(),
        GHAI_BASE_URL: 'https://different.example.invalid/v1',
      }),
    );
  } finally {
    f.cleanup();
  }
});

test('structured findings that invent a file or line fail closed after one bounded attempt', async () => {
  for (const patch of [
    { path: 'invented.mjs', line: 1 },
    { path: 'example.mjs', line: 99 },
  ]) {
    const f = fixture();
    try {
      const response = JSON.stringify({
        summary: 'A potential issue.',
        verdict: 'BLOCK',
        findings: [
          {
            ...patch,
            severity: 'HIGH',
            explanation: 'An issue.',
            fix: 'A fix.',
          },
        ],
      });
      const runner = createRunner(f.env(), async () => sse(events(response)));
      assert.equal((await runner.run()).state, 'unknown');
      assert.equal(finish(f.root), false);
    } finally {
      f.cleanup();
    }
  }
});
