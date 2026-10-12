import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  limits,
  primary,
  fallback,
  models,
  systemPrompt,
  validateModels,
  sha256,
  redact,
  readBounded,
} from './policy.mjs';
import {
  createPrivate,
  replacePrivate,
  append,
  ledger,
  resultPath,
} from './storage.mjs';
import { decision } from './review.mjs';
import { createPostOnce } from './http-once.mjs';
import { reviewSchema, parseReview, renderReview } from './review-format.mjs';

/** @typedef {{input:number,output:number,totalTokens:number,cacheRead:number,cacheWrite:number}} TokenUsage */
/** @typedef {{state:string,model:string,streamed?:boolean,terminalEvent?:string,text?:string,usage?:TokenUsage,status?:number,code?:string,review?:any}} AttemptResult */
/** @param {string} model @param {string} prompt @param {ReturnType<typeof validateModels>} configuration */
export function requestPayload(model, prompt, configuration) {
  assert(configuration.modelIds.includes(model));
  return {
    model,
    instructions: systemPrompt,
    input: [{ role: 'user', content: prompt }],
    stream: true,
    store: false,
    tool_choice: 'none',
    max_output_tokens: limits.maxOutputTokens,
    text: {
      format: {
        type: 'json_schema',
        name: 'bounded_review',
        strict: true,
        schema: reviewSchema,
      },
    },
  };
}
/** @param {number} status @param {unknown} body */
export function isSafeRejection(status, body) {
  if (![400, 404, 422].includes(status) || !body || typeof body !== 'object')
    return false;
  const value = /** @type {{error?:{code?:unknown}}} */ (body);
  return [
    'model_not_found',
    'model_not_supported',
    'unsupported_model',
  ].includes(String(value.error?.code));
}
/** Parse a bounded, fully received SSE response. Never accept HTTP status or [DONE] alone.
 * @param {string} source
 * @returns {{text:string, usage:TokenUsage}}
 */
export function parseCompletedStream(source) {
  assert(Buffer.byteLength(source) <= limits.maxResponseBytes);
  const normalized = source.replaceAll('\r\n', '\n');
  assert(normalized.endsWith('\n\n'), 'Truncated SSE frame');
  let terminal = false;
  let deltaText = '';
  /** @type {any} */
  let response;
  for (const frame of normalized.split('\n\n')) {
    const lines = frame.split('\n');
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n');
    if (raw === '[DONE]') {
      assert(terminal, 'DONE without completed response');
      continue;
    }
    assert(!terminal, 'Events after completed response');
    const event = JSON.parse(raw);
    assert(event && typeof event.type === 'string');
    const eventName = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    if (eventName) assert.equal(eventName, event.type);
    assert(
      !['error', 'response.failed', 'response.incomplete'].includes(event.type),
      'Noncompleted stream',
    );
    assert(
      !/function_call|tool_call|web_search|file_search|computer_call|code_interpreter|mcp_call/.test(
        event.type,
      ),
      'Tool event forbidden',
    );
    if (event.item)
      assert(
        ['message', 'reasoning'].includes(event.item.type),
        'Non-text output item forbidden',
      );
    if (event.type === 'response.output_text.delta') {
      assert(typeof event.delta === 'string');
      deltaText += event.delta;
    }
    if (event.type === 'response.completed') {
      terminal = true;
      response = event.response;
    }
  }
  assert(
    terminal &&
      response?.status === 'completed' &&
      typeof response.id === 'string' &&
      response.id.length > 0,
  );
  assert(Array.isArray(response.output) && response.output.length > 0);
  const textParts = [];
  for (const item of response.output) {
    assert(item && ['message', 'reasoning'].includes(item.type));
    if (item.type === 'reasoning') continue;
    assert(
      item.role === 'assistant' &&
        item.status === 'completed' &&
        Array.isArray(item.content),
    );
    for (const part of item.content) {
      assert(
        part.type === 'output_text' && typeof part.text === 'string',
        'Refusal/non-text output is not a review',
      );
      textParts.push(part.text);
    }
  }
  const text = textParts.join('');
  assert(
    text.trim() && text === deltaText,
    'Terminal text must match streamed text',
  );
  const input = response.usage?.input_tokens;
  const output = response.usage?.output_tokens;
  const totalTokens = response.usage?.total_tokens;
  assert(Number.isSafeInteger(input) && input >= 0);
  assert(
    Number.isSafeInteger(output) &&
      output > 0 &&
      output <= limits.maxOutputTokens,
  );
  assert(Number.isSafeInteger(totalTokens) && totalTokens === input + output);
  const cacheRead = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  assert(
    Number.isSafeInteger(cacheRead) && cacheRead >= 0 && cacheRead <= input,
  );
  return {
    text,
    usage: { input, output, totalTokens, cacheRead, cacheWrite: 0 },
  };
}

/** @typedef {{signal?:AbortSignal,onPayload?:(value:unknown)=>unknown|Promise<unknown>,onResponse?:(response:Response)=>void|Promise<void>}} Hooks */
/** Each runner permits a single network dispatch; reentry, retries and cross-process replay fail closed.
 * @param {NodeJS.ProcessEnv} env @param {typeof fetch} fetchImpl
 */
export function createRunner(env = process.env, fetchImpl = createPostOnce()) {
  const configuration = validateModels(env);
  const model = env.GHAI_REVIEW_MODEL ?? '';
  assert(models.includes(model), 'Unconfigured review slot');
  const modelId =
    model === primary
      ? configuration.primaryModel
      : configuration.fallbackModel;
  assert(env.GHAI_REVIEW_ROOT && env.GHAI_API_KEY);
  const root = resolve(env.GHAI_REVIEW_ROOT);
  const token = env.GHAI_API_KEY;
  assert(
    JSON.stringify(
      JSON.parse(readFileSync(join(root, 'configuration.json'), 'utf8')),
    ) === JSON.stringify(configuration),
    'Prepared configuration mismatch',
  );
  const prompt = readFileSync(join(root, 'prompt.txt'), 'utf8');
  const path = resultPath(root, model);
  const rows = ledger(root);
  assert(!rows.some((row) => row.type === 'policy-stop'));
  if (model === fallback) assert.equal(decision(root, primary), 'fallback');
  else assert.equal(rows.filter((row) => row.type === 'reservation').length, 0);
  createPrivate(join(root, `${model}.lock`), 'single invocation\n');
  append(root, { type: 'armed', model });
  let invoked = false;
  /** @param {string} reason */
  function stop(reason) {
    append(root, { type: 'policy-stop', model, reason });
  }
  /** @param {AttemptResult} value */
  function save(value) {
    replacePrivate(path, value);
    append(root, {
      type: value.state,
      model,
      ...(value.status ? { status: value.status } : {}),
      ...(value.code ? { code: value.code } : {}),
    });
    return value;
  }
  /** @param {Hooks} hooks @returns {Promise<AttemptResult>} */
  async function run(hooks = {}) {
    if (invoked) {
      stop('repeat-invocation');
      throw new Error('Review allowance exhausted; no replay');
    }
    invoked = true;
    const payload = requestPayload(modelId, prompt, configuration);
    const canonical = JSON.stringify(payload);
    try {
      const replacement = await hooks.onPayload?.(payload);
      assert.equal(
        JSON.stringify(replacement ?? payload),
        canonical,
        'Payload mutation blocked',
      );
      assert(Buffer.byteLength(canonical) <= limits.maxRequestBytes);
      assert(!hooks.signal?.aborted);
      const reservations = ledger(root).filter(
        (row) => row.type === 'reservation',
      );
      assert(
        reservations.length < limits.maxAttempts &&
          !reservations.some((row) => row.model === model),
      );
      assert(!ledger(root).some((row) => row.type === 'policy-stop'));
    } catch {
      stop('preflight-rejected');
      throw new Error('Review preflight stopped; no inference');
    }
    // Sync to disk before the only fetch. Failure/kill after this point consumes the attempt.
    append(root, {
      type: 'reservation',
      model,
      attempt:
        ledger(root).filter((row) => row.type === 'reservation').length + 1,
      requestBytes: Buffer.byteLength(canonical),
      requestSha256: sha256(canonical),
      outputLimit: limits.maxOutputTokens,
    });
    createPrivate(path, { model, state: 'unknown', streamed: false });
    try {
      const response = await fetchImpl(configuration.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: canonical,
        signal: AbortSignal.any([
          AbortSignal.timeout(limits.timeoutMs),
          ...(hooks.signal ? [hooks.signal] : []),
        ]),
      });
      await hooks.onResponse?.(response);
      append(root, { type: 'http-response', model, status: response.status });
      if (response.status !== 200) {
        let errorBody;
        try {
          errorBody = JSON.parse(await readBounded(response, 16384));
        } catch {
          /* No raw server error is retained. */
        }
        if (isSafeRejection(response.status, errorBody))
          return save({
            model,
            state: 'rejected-before-execution',
            status: response.status,
            code: errorBody.error.code,
            streamed: false,
          });
        return save({
          model,
          state: 'http-failure-billing-unknown',
          status: response.status,
          streamed: false,
        });
      }
      assert(
        /^text\/event-stream(?:;|$)/i.test(
          response.headers.get('content-type') ?? '',
        ),
      );
      const parsed = parseCompletedStream(
        await readBounded(response, limits.maxResponseBytes),
      );
      const diff = readFileSync(join(root, 'diff.txt'), 'utf8');
      const review = parseReview(parsed.text, diff);
      const hidden = [
        token,
        configuration.primaryModel,
        configuration.fallbackModel,
        configuration.baseUrl,
        configuration.endpoint,
        new URL(configuration.baseUrl).hostname,
        env.GITHUB_TOKEN ?? '',
        env.INPUT_GITHUB_TOKEN ?? '',
      ];
      // Redact decoded string fields: serialized JSON can escape credential bytes.
      const safeReview = parseReview(
        JSON.stringify(review, (_key, value) =>
          typeof value === 'string' ? redact(value, hidden) : value,
        ),
        diff,
      );
      const provenance = JSON.parse(
        readFileSync(join(root, 'provenance.json'), 'utf8'),
      );
      return save({
        model,
        state: 'completed',
        streamed: true,
        terminalEvent: 'response.completed',
        review: safeReview,
        text: renderReview(safeReview, provenance),
        usage: parsed.usage,
      });
    } catch {
      return save({ model, state: 'unknown', streamed: false });
    }
  }
  return { run, stop, slot: model, configuration };
}
