// Loaded before tests/imports in each node:test process. Loopback servers are fixtures.
import assert from 'node:assert/strict';
import net from 'node:net';
const allowed = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );
  assert(
    allowed.has(url.hostname),
    'Offline test blocked a non-loopback fetch',
  );
  return fetchOriginal(input, { ...options, redirect: 'error' });
};
const connectOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const params = Array.isArray(args[0]) ? args[0] : args;
  const first = params[0];
  const options = typeof first === 'object' && first !== null ? first : {};
  const host =
    options.host ?? (typeof params[1] === 'string' ? params[1] : 'localhost');
  assert(allowed.has(host), 'Offline test blocked a non-loopback socket');
  return Reflect.apply(connectOriginal, this, args);
};
