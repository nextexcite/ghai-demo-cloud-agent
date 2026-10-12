import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/**
 * One Node HTTP client request with no redirect handling, retry adapter, or
 * Fetch-layer 421 redispatch. The injected requester is for loopback tests only.
 * @param {typeof import('node:https').request} requestImpl
 * @returns {typeof fetch}
 */
export function createPostOnce(requestImpl = httpsRequest) {
  return async (input, init = {}) => {
    assert(!(input instanceof Request));
    assert.equal(init.method, 'POST');
    assert.equal(typeof init.body, 'string');
    const body = init.body;
    return new Promise((resolve, reject) => {
      const request = requestImpl(
        new URL(String(input)),
        {
          method: 'POST',
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          signal: init.signal ?? undefined,
        },
        (incoming) => {
          const status = incoming.statusCode ?? 0;
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value))
              for (const item of value) headers.append(key, item);
            else if (value !== undefined) headers.set(key, value);
          }
          try {
            // These statuses cannot have a Web Response body; drain without replay.
            const noBody = [204, 205, 304].includes(status);
            if (noBody) incoming.resume();
            resolve(
              new Response(
                noBody
                  ? null
                  : /** @type {ReadableStream<Uint8Array>} */ (
                      Readable.toWeb(incoming)
                    ),
                { status, headers },
              ),
            );
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
        },
      );
      request.once('error', reject);
      request.end(body);
    });
  };
}
