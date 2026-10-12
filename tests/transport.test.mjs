import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRunner,
  parseCompletedStream,
  isSafeRejection,
} from '../ops/ci/transport.mjs';
import { decision, finish } from '../ops/ci/review.mjs';
import { primary, fallback, limits } from '../ops/ci/policy.mjs';
import { ledger } from '../ops/ci/storage.mjs';
import {
  endpoint,
  reviewText,
  fixture,
  token,
  events,
  encode,
  sse,
  read,
} from './helpers.mjs';

test('one reserved raw POST, fixed Responses payload, completion and sanitized billing report', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const runner = createRunner(f.env(), async (url, init) => {
      calls++;
      assert.equal(url, endpoint);
      assert.equal(init.redirect, 'error');
      assert.equal(init.method, 'POST');
      assert.equal(
        ledger(f.root).filter((row) => row.type === 'reservation').length,
        1,
      );
      assert.equal(read(f.root, `${primary}.json`).state, 'unknown');
      const body = JSON.parse(init.body);
      assert.equal(body.max_output_tokens, 2048);
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.tool_choice, 'none');
      assert(!('tools' in body));
      assert(!JSON.stringify(body).includes(token));
      return sse();
    });
    const order = [];
    const result = await runner.run({
      onPayload: (payload) => {
        order.push('payload');
        return payload;
      },
      onResponse: () => {
        order.push('response');
      },
    });
    assert.equal(result.state, 'completed');
    assert.equal(calls, 1);
    assert.deepEqual(order, ['payload', 'response']);
    assert.equal(decision(f.root, primary), 'completed');
    assert.throws(() => createRunner(f.env(fallback)), /fallback/);
    assert.throws(() => createRunner(f.env()));
    assert.equal(finish(f.root), true);
    assert.equal(read(f.root, 'report.json').actualBillingUsd, null);
    assert.match(readFileSync(join(f.root, 'review.md'), 'utf8'), /OK/);
  } finally {
    f.cleanup();
  }
});

test('explicit model rejection alone permits one separately accounted fallback', async () => {
  const f = fixture();
  try {
    const first = createRunner(f.env(), async () =>
      Response.json(
        {
          error: { code: 'model_not_found', message: 'private-server-detail' },
        },
        { status: 404 },
      ),
    );
    assert.equal((await first.run()).state, 'rejected-before-execution');
    assert.equal(decision(f.root, primary), 'fallback');
    const second = createRunner(f.env(fallback), async () => sse());
    await second.run();
    assert.equal(decision(f.root, fallback), 'completed');
    assert.equal(
      ledger(f.root).filter((row) => row.type === 'reservation').length,
      2,
    );
    assert.equal(finish(f.root), true);
    assert.equal(read(f.root, 'report.json').model, fallback);
    await assert.rejects(second.run());
    assert.equal(decision(f.root, fallback), 'stop');
    assert.equal(finish(f.root), false);
    assert(
      !readFileSync(join(f.root, 'attempts.jsonl'), 'utf8').includes(
        'private-server-detail',
      ),
    );
  } finally {
    f.cleanup();
  }
});

for (const [label, response] of [
  [
    'network interruption',
    () => {
      throw new Error('private server secret');
    },
  ],
  [
    'HTTP 503',
    () =>
      Response.json({ error: { code: 'model_not_found' } }, { status: 503 }),
  ],
  [
    'HTTP 429',
    () =>
      Response.json(
        { error: { code: 'rate_limit_exceeded' } },
        { status: 429 },
      ),
  ],
  [
    'HTTP 401',
    () =>
      Response.json({ error: { code: 'model_not_found' } }, { status: 401 }),
  ],
  [
    'unknown HTTP 400',
    () => Response.json({ error: { code: 'unknown' } }, { status: 400 }),
  ],
  ['non-SSE 200', () => Response.json({ status: 'completed' })],
  [
    'empty response',
    () =>
      new Response('', { headers: { 'content-type': 'text/event-stream' } }),
  ],
  [
    'SSE interruption',
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: partial'));
            c.error(new Error('stream broke'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  ],
])
  test(`${label} spends primary and blocks fallback/replay`, async () => {
    const f = fixture();
    try {
      let calls = 0;
      const run = createRunner(f.env(), async () => {
        calls++;
        return response();
      });
      const result = await run.run();
      assert.notEqual(result.state, 'completed');
      assert.equal(decision(f.root, primary), 'stop');
      assert.throws(() => createRunner(f.env(fallback)));
      await assert.rejects(run.run());
      assert.equal(calls, 1);
      assert.equal(finish(f.root), false);
      assert.equal(read(f.root, 'report.json').reservations, 1);
      assert(
        !readFileSync(join(f.root, 'attempts.jsonl'), 'utf8').includes(
          'private server secret',
        ),
      );
    } finally {
      f.cleanup();
    }
  });

for (const [label, change] of [
  ['mutated cap', (payload) => ({ ...payload, max_output_tokens: 99999 })],
  ['added tools', (payload) => ({ ...payload, tools: [{ type: 'function' }] })],
  ['wrong model', (payload) => ({ ...payload, model: fallback })],
  ['background request', (payload) => ({ ...payload, background: true })],
  [
    'in-place mutation',
    (payload) => {
      payload.model = fallback;
    },
  ],
])
  test(`${label} rejected after hook before any dispatch`, async () => {
    const f = fixture();
    try {
      let calls = 0;
      const runner = createRunner(f.env(), async () => {
        calls++;
        return sse();
      });
      await assert.rejects(runner.run({ onPayload: change }));
      assert.equal(calls, 0);
      assert.equal(decision(f.root, primary), 'stop');
    } finally {
      f.cleanup();
    }
  });

test('UTF-8 request bound, cancellation, missing credential and wrong presets fail closed', async () => {
  const f = fixture();
  try {
    for (const env of [
      { ...f.env(), GHAI_API_KEY: '' },
      { ...f.env(), GHAI_REVIEW_MODEL: 'wrong' },
      { ...f.env(), GHAI_BASE_URL: 'https://example.com' },
    ])
      assert.throws(() => createRunner(env));
    writeFileSync(
      join(f.root, 'prompt.txt'),
      'é'.repeat(limits.maxRequestBytes),
    );
    let calls = 0;
    const runner = createRunner(f.env(), async () => {
      calls++;
      return sse();
    });
    await assert.rejects(runner.run());
    assert.equal(calls, 0);
  } finally {
    f.cleanup();
  }
  const second = fixture();
  try {
    const runner = createRunner(second.env(), async () => {
      throw new Error('must not call');
    });
    await assert.rejects(runner.run({ signal: AbortSignal.abort() }));
    assert.equal(
      ledger(second.root).filter((row) => row.type === 'reservation').length,
      0,
    );
  } finally {
    second.cleanup();
  }
});

test('concurrent calls still cause exactly one dispatch', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const runner = createRunner(f.env(), async () => {
      calls++;
      return sse();
    });
    await Promise.allSettled([runner.run(), runner.run()]);
    assert(calls <= 1);
    assert.equal(decision(f.root, primary), 'stop');
  } finally {
    f.cleanup();
  }
});

test('strict terminal SSE, usage and tool checks reject false success', () => {
  assert.equal(parseCompletedStream(encode(events())).text, reviewText());
  const cases = [];
  cases.push(encode(events().slice(0, 2)));
  cases.push('data: [DONE]\n\n');
  cases.push(encode(events()).trimEnd());
  cases.push(encode(events()) + encode(events().slice(0, 1)));
  cases.push(encode([{ type: 'response.failed' }]));
  cases.push(encode([{ type: 'response.incomplete' }]));
  cases.push(
    encode([
      { type: 'response.output_item.added', item: { type: 'function_call' } },
      ...events(),
    ]),
  );
  for (const mutate of [
    (r) => {
      r.status = 'incomplete';
    },
    (r) => {
      r.usage.output_tokens = 2049;
      r.usage.total_tokens = 2069;
    },
    (r) => {
      r.usage.output_tokens = -1;
    },
    (r) => {
      delete r.usage;
    },
    (r) => {
      r.usage.total_tokens = 5;
    },
    (r) => {
      r.output[0].content[0].text = 'mismatch';
    },
    (r) => {
      r.output[0].type = 'function_call';
    },
    (r) => {
      r.output[0].content[0].type = 'refusal';
    },
    (r) => {
      r.output[0].status = 'in_progress';
    },
  ]) {
    const e = events();
    mutate(e[2].response);
    cases.push(encode(e));
  }

  cases.push('x'.repeat(limits.maxResponseBytes + 1));
  for (const value of cases) assert.throws(() => parseCompletedStream(value));
});

test('bounded body cancels on oversize and saves no raw response', async () => {
  const f = fixture();
  let cancelled = false;
  try {
    const runner = createRunner(
      f.env(),
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(limits.maxResponseBytes + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    assert.equal((await runner.run()).state, 'unknown');
    assert.equal(cancelled, true);
  } finally {
    f.cleanup();
  }
});

test('redacts known token, bearer values, and credential patterns before storing review', async () => {
  const f = fixture();
  try {
    const runner = createRunner(f.env(), async () =>
      sse(
        events(
          reviewText(
            `${token}\nBearer abcsecret\nghp_${'x'.repeat(30)}\n<script>bad</script>`,
          ),
        ),
      ),
    );
    await runner.run();
    finish(f.root);
    const result = readFileSync(join(f.root, 'review.md'), 'utf8');
    assert(!result.includes(token));
    assert(!result.includes('abcsecret'));
    assert(!result.includes('ghp_'));
    assert(!result.includes('<script>'));
    assert(result.includes('&#60;script&#62;'));
  } finally {
    f.cleanup();
  }
});

test('fallback classifier requires status plus exact known rejection code', () => {
  for (const status of [400, 404, 422])
    assert.equal(
      isSafeRejection(status, { error: { code: 'model_not_found' } }),
      true,
    );
  for (const status of [200, 401, 403, 429, 500, 503])
    assert.equal(
      isSafeRejection(status, { error: { code: 'model_not_found' } }),
      false,
    );
  assert.equal(isSafeRejection(404, { message: 'model_not_found' }), false);
  assert.equal(isSafeRejection(404, null), false);
});

test('bare CR and CRLF cannot escape inert review Markdown', async () => {
  const f = fixture();
  try {
    const runner = createRunner(f.env(), async () =>
      sse(
        events(
          reviewText(
            'safe\r![x](https://example.test)\r\n<script>bad</script>',
          ),
        ),
      ),
    );
    await runner.run();
    finish(f.root);
    const review = readFileSync(join(f.root, 'review.md'), 'utf8');
    assert(!review.includes('\r'));
    assert(!review.includes('![x](https://example.test)'));
    assert(!review.includes('<script>'));
    assert(!review.includes('\n!['));
  } finally {
    f.cleanup();
  }
});
