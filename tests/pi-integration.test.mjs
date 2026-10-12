import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  fixture,
  events,
  encode,
  endpoint,
  configuration,
} from './helpers.mjs';
import { primary } from '../ops/ci/policy.mjs';
import { decision } from '../ops/ci/review.mjs';

for (const runtime of [
  { name: 'action SDK', version: '1.0.4', package: 'pi-action-runtime' },
  {
    name: 'standalone SDK',
    version: '1.1.0',
    package: '@earendil-works/pi-coding-agent',
  },
])
  for (const succeeds of [true, false])
    test(`installed ${runtime.name} ${runtime.version} loads extension and ${succeeds ? 'completes' : 'rejects truncated'} mocked SSE without network`, () => {
      const f = fixture();
      try {
        const cli = fileURLToPath(
          new URL(
            `../node_modules/${runtime.package}/dist/cli.js`,
            import.meta.url,
          ),
        );
        assert.equal(
          JSON.parse(
            readFileSync(
              new URL(
                `../node_modules/${runtime.package}/package.json`,
                import.meta.url,
              ),
              'utf8',
            ),
          ).version,
          runtime.version,
        );
        const dispatcher = new URL(
          './core/http-dispatcher.js',
          pathToFileURL(cli),
        );
        const preload = join(f.dir, 'mock-provider.mjs');
        const stream = encode(succeeds ? events() : events().slice(0, 2));
        writeFileSync(
          preload,
          `
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
await import(${JSON.stringify(dispatcher.href)});
globalThis.fetch = async () => { throw Error('Unexpected fixture Fetch network attempt'); };
https.request = (url, init, callback) => {
  if (String(url) !== ${JSON.stringify(endpoint)}) throw Error('Unexpected offline fixture network attempt');
  const request = new EventEmitter();
  request.end = (body) => {
    if (JSON.parse(body).max_output_tokens !== 2048) throw Error('Unbounded fixture request');
    if (JSON.parse(body).model !== ${JSON.stringify(configuration.GHAI_PI_PRIMARY_MODEL)}) throw Error('Incorrect private wire model');
    const incoming = Readable.from([Buffer.from(${JSON.stringify(stream)})]);
    incoming.statusCode = 200;
    incoming.headers = {'content-type':'text/event-stream'};
    queueMicrotask(() => callback(incoming));
  };
  return request;
};
syncBuiltinESMExports();
`,
        );
        const args = [
          '--import',
          fileURLToPath(new URL('./offline-network.mjs', import.meta.url)),
          '--import',
          preload,
          cli,
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-context-files',
          '--no-prompt-templates',
          '--no-themes',
          '--no-mcp',
          '--offline',
          '--model',
          `ghai/${primary}`,
          '--tools',
          'ghai_review_disabled',
          '--extension',
          fileURLToPath(
            new URL('../ops/ci/pi-review-extension.ts', import.meta.url),
          ),
          '--mode',
          'json',
          '--print',
          'Review only the prepared patch.',
        ];
        const result = spawnSync(process.execPath, args, {
          cwd: join(f.root, 'workspace'),
          timeout: 30000,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: join(f.root, 'home'),
            PI_CODING_AGENT_DIR: join(f.root, 'agent'),
            PI_OFFLINE: '1',
            PI_TELEMETRY: '0',
            ...f.env(),
          },
        });
        assert.equal(result.signal, null, result.stderr);
        for (const hidden of Object.values(configuration))
          assert(
            !(result.stdout + result.stderr)
              .toLowerCase()
              .includes(hidden.toLowerCase()),
            'Private configuration leaked to Pi output',
          );
        if (succeeds) {
          assert.equal(result.status, 0, result.stderr + result.stdout);
          assert.match(result.stdout, /OK/);
          const outputEvents = result.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          const assistantMessages = outputEvents.flatMap((event) =>
            event.message?.role === 'assistant' ? [event.message] : [],
          );
          assert(assistantMessages.length > 0);
          assert(
            assistantMessages.every((message) => message.model === primary),
          );
          assert.equal(decision(f.root, primary), 'completed');
        } else {
          assert(
            !result.stdout.includes('No demonstrated defect'),
            'Partial text must never reach Pi output',
          );
          assert.equal(decision(f.root, primary), 'stop');
        }
        const rows = readFileSync(join(f.root, 'attempts.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse);
        assert.equal(
          rows.filter((row) => row.type === 'reservation').length,
          1,
          result.stderr + result.stdout,
        );
      } finally {
        f.cleanup();
      }
    });
