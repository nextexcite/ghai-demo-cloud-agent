import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure, buildPrompt } from '../ops/ci/review.mjs';
import { primary } from '../ops/ci/policy.mjs';
export const baseUrl = 'https://gateway.example.invalid/v1';
export const endpoint = baseUrl + '/responses';
export const configuration = {
  GHAI_BASE_URL: baseUrl,
  GHAI_PI_PRIMARY_MODEL: 'fixture-primary',
  GHAI_PI_FALLBACK_MODEL: 'fixture-fallback',
};
export const sampleDiff =
  'diff --git a/example.mjs b/example.mjs\n--- a/example.mjs\n+++ b/example.mjs\n@@ -1 +1 @@\n-old value\n+new value\n';
export const reviewText = (
  summary = 'No demonstrated defect in this bounded patch.',
) => JSON.stringify({ summary, verdict: 'OK', findings: [] });
export const token = 'fixture-only-not-a-credential';
export const metadata = {
  repository: 'example/demo',
  workflowSha: 'c'.repeat(40),
  pr: 1,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
};
export function fixture(runtimeConfig = configuration) {
  const dir = mkdtempSync(join(tmpdir(), 'ghai-demo-test-'));
  const root = join(dir, 'review');
  configure(
    root,
    buildPrompt(sampleDiff, metadata),
    {
      ...metadata,
      diffSha256: 'd'.repeat(64),
      diffBytes: Buffer.byteLength(sampleDiff),
    },
    runtimeConfig,
    sampleDiff,
  );
  return {
    dir,
    root,
    env: (model = primary) => ({
      ...runtimeConfig,
      GHAI_REVIEW_ROOT: root,
      GHAI_REVIEW_MODEL: model,
      GHAI_API_KEY: token,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
export function events(text = reviewText()) {
  return [
    {
      type: 'response.created',
      response: { id: 'fixture-response', status: 'in_progress' },
    },
    {
      type: 'response.output_text.delta',
      delta: text,
      output_index: 0,
      content_index: 0,
    },
    {
      type: 'response.completed',
      response: {
        id: 'fixture-response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text }],
          },
        ],
        usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 },
      },
    },
  ];
}
export const encode = (items) =>
  items
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
export const sse = (items = events()) =>
  new Response(encode(items), {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
export const read = (root, file) =>
  JSON.parse(readFileSync(join(root, file), 'utf8'));
