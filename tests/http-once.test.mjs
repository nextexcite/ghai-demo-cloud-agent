import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createPostOnce } from '../ops/ci/http-once.mjs';

for (const status of [421, 302, 401, 503, 200])
  test(`real loopback HTTP ${status}: exactly one complete POST, no redirect/retry`, async () => {
    let requests = 0;
    const bodies = [];
    const server = createServer(async (req, res) => {
      requests++;
      assert.equal(req.headers.authorization, 'Bearer fixture-only');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      bodies.push(Buffer.concat(chunks).toString());
      res.writeHead(status, {
        'content-type': 'text/plain',
        location: '/must-not-follow',
      });
      res.end('synthetic response');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address();
      const transport = createPostOnce(request);
      const result = await transport(`http://127.0.0.1:${port}/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-only' },
        body: '{"synthetic":true}',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(result.status, status);
      assert.equal(await result.text(), 'synthetic response');
      assert.equal(requests, 1);
      assert.deepEqual(bodies, ['{"synthetic":true}']);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

test(
  'real stalled response aborts body reading without another POST',
  { timeout: 5000 },
  async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"response.created"}\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address();
      const controller = new AbortController();
      const response = await createPostOnce(request)(
        `http://127.0.0.1:${port}/responses`,
        {
          method: 'POST',
          body: '{}',
          signal: controller.signal,
        },
      );
      const read = response.text();
      controller.abort();
      await assert.rejects(read);
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test(
  'cancelling Response body destroys the real incoming stream',
  { timeout: 5000 },
  async () => {
    let requests = 0;
    let disconnected;
    const closed = new Promise((resolve) => {
      disconnected = resolve;
    });
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      res.on('close', disconnected);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('partial stream');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address();
      const response = await createPostOnce(request)(
        `http://127.0.0.1:${port}/responses`,
        {
          method: 'POST',
          body: '{}',
          signal: AbortSignal.timeout(3000),
        },
      );
      await response.body.cancel();
      await closed;
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
