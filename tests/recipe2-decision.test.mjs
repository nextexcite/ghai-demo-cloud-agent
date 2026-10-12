import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  decideQa,
  decisionUrl,
} from '../recipes/02-e2b-development/decision.mjs';

const input = {
  baseUrl: 'https://decision.invalid/v1',
  apiKey: 'offline-fixture-key',
  evidence: {
    hardChecks: ['lint', 'typecheck', 'test', 'build'].map((check) => ({
      check,
      status: 'passed',
    })),
    specifications: 'Add a task and mark it complete.',
    observations: { taskAdded: true, taskCompleted: true },
  },
};
function answer(
  choice = 'ready_for_review',
  options = ['ready_for_review', 'repair', 'ask_human'],
  focus = choice === 'repair' ? 'quick_add' : 'none',
) {
  return {
    model: 'jev-fixture',
    answers: {
      focus: {
        type: 'choice',
        choice: focus,
        confidence: 0.1,
        probabilities: Object.fromEntries(
          [
            'quick_add',
            'persistence',
            'due',
            'reminder',
            'assignee',
            'none',
          ].map((key) => [key, key === focus ? 1 : 0]),
        ),
      },
      next: {
        type: 'choice',
        choice,
        confidence: 0.9,
        probabilities: Object.fromEntries(
          options.map((key) => [key, key === choice ? 1 : 0]),
        ),
      },
    },
    usage: { input_tokens: 120, output_tokens: 20 },
  };
}
function fixture(
  value,
  {
    status = 200,
    headers = {},
    chunks,
    interrupted = false,
    stalled = false,
  } = {},
) {
  let calls = 0;
  const captured = {};
  const requestImpl = (url, options, callback) => {
    calls++;
    Object.assign(captured, { url: url.href, options });
    const request = new EventEmitter();
    request.destroy = () => {
      captured.destroyed = true;
    };
    request.end = (body) => {
      captured.body = JSON.parse(body);
      if (stalled) return;
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = status;
        response.headers = { 'content-type': 'application/json', ...headers };
        response.complete = !interrupted;
        response.destroy = () => {
          captured.responseDestroyed = true;
        };
        callback(response);
        for (const chunk of chunks ?? [Buffer.from(JSON.stringify(value))])
          response.emit('data', chunk);
        if (interrupted) response.emit('aborted');
        else response.emit('end');
      });
    };
    return request;
  };
  return { requestImpl, captured, calls: () => calls };
}

test('decision URL appends SystemOne once and rejects unsafe endpoints', () => {
  for (const suffix of ['/v1', '/v1/', '/v1/systemone', '/v1/systemone/'])
    assert.equal(
      decisionUrl(`https://example.invalid${suffix}`),
      'https://example.invalid/v1/systemone',
    );
  for (const url of [
    undefined,
    '',
    'https://example.invalid',
    'http://example.invalid/v1',
    'https://user:pass@example.invalid/v1',
    'https://example.invalid/v1?x=1',
    'https://example.invalid/v1?',
    'https://example.invalid/v1#',
    'https://example.invalid/v1#x',
    'https://example.invalid/v1/responses',
    'https://example.invalid/v1/systemone/systemone',
    ' https://example.invalid/v1',
    'https://example.invalid\\v1',
  ])
    assert.throws(() => decisionUrl(url), /Decision base URL/);
});

test('typed QA choice uses default model and one native request', async () => {
  const mock = fixture(answer());
  assert.deepEqual(await decideQa(input, mock), {
    action: 'ready_for_review',
    focus: 'none',
  });
  assert.equal(mock.calls(), 1);
  assert.equal(mock.captured.url, 'https://decision.invalid/v1/systemone');
  assert.equal(mock.captured.options.method, 'POST');
  assert.equal(mock.captured.options.agent, false);
  assert.equal(
    mock.captured.options.headers.Authorization,
    `Bearer ${input.apiKey}`,
  );
  assert.equal(mock.captured.body.model, 'jev-latest');
  assert.deepEqual(mock.captured.body.state, input.evidence);
  assert.equal(mock.captured.body.questions.next.type, 'choice');
  assert.deepEqual(Object.keys(mock.captured.body.questions.next.criteria), [
    'ready_for_review',
    'repair',
    'ask_human',
  ]);
  assert.equal(Object.hasOwn(mock.captured.body, 'tools'), false);
  assert.deepEqual(Object.keys(mock.captured.body.questions), [
    'next',
    'focus',
  ]);
  assert.equal(mock.captured.body.questions.focus.type, 'choice');
  assert.deepEqual(Object.keys(mock.captured.body.questions.focus.criteria), [
    'quick_add',
    'persistence',
    'due',
    'reminder',
    'assignee',
    'none',
  ]);
});

test('configurable model and each validated action are supported', async () => {
  for (const action of ['ready_for_review', 'repair', 'ask_human']) {
    const mock = fixture(answer(action));
    assert.deepEqual(await decideQa({ ...input, model: 'custom-jev' }, mock), {
      action,
      focus: action === 'repair' ? 'quick_add' : 'none',
    });
    assert.equal(mock.captured.body.model, 'custom-jev');
  }
});

test('hard failures cannot become ready, even if model attempts an override', async () => {
  for (const status of ['failed', 'unknown', 'skipped', 'not-run']) {
    const evidence = { hardChecks: [{ check: 'test', status }] };
    const mock = fixture(answer('repair', ['repair', 'ask_human']));
    assert.deepEqual(await decideQa({ ...input, evidence }, mock), {
      action: 'repair',
      focus: 'quick_add',
    });
    assert.deepEqual(Object.keys(mock.captured.body.questions.next.criteria), [
      'repair',
      'ask_human',
    ]);
    const override = fixture(answer());
    await assert.rejects(
      decideQa({ ...input, evidence }, override),
      /Invalid SystemOne/,
    );
    assert.equal(override.calls(), 1);
  }
});

test('malformed or oversized evidence is rejected before dispatch', async () => {
  const cyclic = { ...input.evidence };
  cyclic.self = cyclic;
  const getter = {
    get hardChecks() {
      throw new Error('getter must not run');
    },
  };
  for (const evidence of [
    undefined,
    {},
    { hardChecks: [] },
    { hardChecks: [{ check: 'test', status: 'probably' }] },
    { ...input.evidence, text: 'x'.repeat(32769) },
    { ...input.evidence, text: input.apiKey },
    { ...input.evidence, value: Infinity },
    { ...input.evidence, value: () => true },
    cyclic,
    getter,
  ]) {
    const mock = fixture(answer());
    await assert.rejects(
      decideQa({ ...input, evidence }, mock),
      /Decision evidence/,
    );
    assert.equal(mock.calls(), 0);
  }
});

test('strict response validation rejects malformed schema and distributions', async () => {
  const mutations = [
    (x) => {
      delete x.model;
    },
    (x) => {
      x.extra = 'raw';
    },
    (x) => {
      x.answers.extra = x.answers.next;
    },
    (x) => {
      delete x.answers.next.type;
    },
    (x) => {
      x.answers.next.type = 'noul';
    },
    (x) => {
      x.answers.next.choice = 'publish';
    },
    (x) => {
      x.answers.next.confidence = 2;
    },
    (x) => {
      x.answers.next.probabilities.repair = -1;
    },
    (x) => {
      x.answers.next.probabilities.repair = 1;
    },
    (x) => {
      delete x.answers.next.probabilities.ask_human;
    },
    (x) => {
      x.answers.next.probabilities.extra = 0;
    },
    (x) => {
      x.answers.next.choice = 'repair';
    },
    (x) => {
      x.usage.input_tokens = -1;
    },
    (x) => {
      x.usage.output_tokens = 1.5;
    },
  ];
  for (const mutate of mutations) {
    const value = answer();
    mutate(value);
    const mock = fixture(value);
    await assert.rejects(
      decideQa(input, mock),
      /Invalid SystemOne decision response/,
    );
    assert.equal(mock.calls(), 1);
  }
});

test('redirects, 421, rate limits, server errors and malformed responses never retry', async () => {
  for (const config of [
    ...[301, 302, 307, 308, 401, 421, 429, 500, 529].map((status) => ({
      status,
      headers: { location: 'https://other.invalid/v1/systemone' },
    })),
    { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-encoding': 'gzip' } },
    { headers: { 'content-length': '16385' } },
    { headers: { 'content-length': '1' } },
    { chunks: [Buffer.from('{"secret":"offline-fixture-key"')] },
    { chunks: [Buffer.from([255])] },
    { chunks: [Buffer.alloc(16385)] },
    { interrupted: true },
  ]) {
    const mock = fixture(answer(), config);
    await assert.rejects(decideQa(input, mock), (error) => {
      assert.match(error.message, /outcome unknown; no automatic retry/);
      assert.equal(error.message.includes(input.apiKey), false);
      assert.equal(error.message.includes('other.invalid'), false);
      return true;
    });
    assert.equal(mock.calls(), 1);
  }
});

test('absolute deadline aborts a stalled request once', async () => {
  const mock = fixture(answer(), { stalled: true });
  await assert.rejects(
    decideQa(input, { ...mock, timeoutMs: 5 }),
    /outcome unknown/,
  );
  assert.equal(mock.calls(), 1);
  assert.equal(mock.captured.destroyed, true);
});

test('raw transport errors and invalid configuration do not expose credentials', async () => {
  let calls = 0;
  await assert.rejects(
    decideQa(input, {
      requestImpl() {
        calls++;
        throw new Error(input.apiKey);
      },
    }),
    (error) => !error.message.includes(input.apiKey),
  );
  assert.equal(calls, 1);
  for (const change of [
    { apiKey: '' },
    { apiKey: 'key\nheader' },
    { model: '' },
    { model: 'bad model' },
  ]) {
    const mock = fixture(answer());
    await assert.rejects(decideQa({ ...input, ...change }, mock));
    assert.equal(mock.calls(), 0);
  }
});

test('exhausted repair allowance removes repair and rejects attempted repair', async () => {
  const evidence = {
    hardChecks: [{ check: 'test', status: 'failed' }],
    repairRemaining: false,
  };
  const mock = fixture(answer('ask_human', ['ask_human']));
  assert.deepEqual(await decideQa({ ...input, evidence }, mock), {
    action: 'ask_human',
    focus: 'none',
  });
  assert.deepEqual(Object.keys(mock.captured.body.questions.next.criteria), [
    'ask_human',
  ]);
  await assert.rejects(
    decideQa(
      { ...input, evidence },
      fixture(answer('repair', ['repair', 'ask_human'])),
    ),
    /Invalid SystemOne/,
  );
});

test('semantic focus is validated and repair always names a criterion', async () => {
  for (const focus of [
    'quick_add',
    'persistence',
    'due',
    'reminder',
    'assignee',
  ]) {
    const mock = fixture(
      answer('repair', ['ready_for_review', 'repair', 'ask_human'], focus),
    );
    assert.deepEqual(await decideQa(input, mock), { action: 'repair', focus });
    assert.equal(mock.calls(), 1);
  }
  await assert.rejects(
    decideQa(
      input,
      fixture(
        answer('repair', ['ready_for_review', 'repair', 'ask_human'], 'none'),
      ),
    ),
    /Invalid SystemOne/,
  );
  for (const mutate of [
    (x) => {
      delete x.answers.focus;
    },
    (x) => {
      x.answers.focus.type = 'score';
    },
    (x) => {
      x.answers.focus.choice = 'unknown';
    },
    (x) => {
      x.answers.focus.confidence = -1;
    },
    (x) => {
      x.answers.focus.probabilities.none = 0;
    },
    (x) => {
      x.answers.focus.probabilities.unrequested = 0;
    },
    (x) => {
      delete x.answers.focus.probabilities.due;
    },
  ]) {
    const response = answer();
    mutate(response);
    await assert.rejects(
      decideQa(input, fixture(response)),
      /Invalid SystemOne/,
    );
  }
});
