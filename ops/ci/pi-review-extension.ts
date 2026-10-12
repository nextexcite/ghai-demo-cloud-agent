import assert from 'node:assert/strict';
import {
  Type,
  createAssistantMessageEventStream,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ProviderConfig,
} from '@earendil-works/pi-coding-agent';
import { limits, models, systemPrompt } from './policy.mjs';
import { createRunner } from './transport.mjs';

export default function reviewExtension(pi: ExtensionAPI) {
  const runner = createRunner();
  // Display-only metadata. The custom transport alone resolves private configuration.
  const baseUrl = 'https://review.invalid/v1';
  const streamSimple: NonNullable<ProviderConfig['streamSimple']> = (
    model,
    context,
    options = {},
  ) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      api: 'openai-responses',
      provider: 'ghai',
      model: runner.slot,
      content: [],
      stopReason: 'error',
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        // Required SDK display placeholders, never asserted prices. Artifacts retain billing:null.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void (async () => {
      try {
        assert.equal(model.provider, 'ghai');
        assert.equal(model.id, runner.slot);
        assert.equal(model.api, 'openai-responses');
        assert.equal(model.baseUrl, baseUrl);
        assert.equal(getCurrentTools(context.messages).length, 0);
        // Do not expose private wire payloads or response headers to SDK logging hooks.
        const result = await runner.run({ signal: options.signal });
        assert.equal(result.state, 'completed');
        assert(result.text && result.usage);
        message.content = [{ type: 'text', text: result.text }];
        message.usage = { ...result.usage, cost: message.usage.cost };
        message.stopReason = 'stop';
        // No partial text is exposed before the upstream terminal event is verified.
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: result.text,
          partial: message,
        });
        stream.push({
          type: 'text_end',
          contentIndex: 0,
          content: result.text,
          partial: message,
        });
        stream.push({ type: 'done', reason: 'stop', message });
      } catch {
        message.errorMessage =
          'Bounded review stopped. Inspect sanitized accounting; no automatic replay.';
        stream.push({ type: 'error', reason: 'error', error: message });
      } finally {
        stream.end();
      }
    })();
    return stream;
  };
  pi.registerProvider('ghai', {
    api: 'openai-responses',
    baseUrl,
    apiKey: 'display-only-noncredential-placeholder',
    streamSimple,
    models: models.map((id) => ({
      id,
      name: id,
      api: 'openai-responses',
      input: ['text'],
      reasoning: false,
      contextWindow: 65536,
      maxTokens: limits.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  pi.registerTool({
    name: 'ghai_review_disabled',
    label: 'Tools disabled',
    description: 'Sentinel; no tools are permitted.',
    parameters: Type.Object({}),
    defaultActive: false,
    async execute() {
      runner.stop('tool-execution');
      throw new Error('Review tools are disabled');
    },
  });
  pi.on('session_start', () => {
    pi.setActiveTools([]);
  });
  pi.on('before_agent_start', () => {
    pi.setActiveTools([]);
    return { systemPrompt };
  });
  pi.on('tool_call', () => {
    runner.stop('tool-call');
    return { block: true, reason: 'Review tools are disabled' };
  });
  pi.on('session_before_compact', () => {
    runner.stop('compaction');
    return { cancel: true };
  });
}
