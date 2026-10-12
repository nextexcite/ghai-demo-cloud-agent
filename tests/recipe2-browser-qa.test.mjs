import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { runBrowserQa } from '../recipes/02-e2b-development/browser-qa.mjs';

function fixture(overrides = {}) {
  const calls = [];
  let todo;
  let home;
  let stopped = false;
  const options = {
    appDir: '/tmp/example-todo-app',
    async startServer(command, args, settings) {
      calls.push({ command, args, settings });
      home = settings.env.HOME;
      assert.equal(settings.env.GHAI_API_KEY, undefined);
      assert.equal(settings.env.CONTEXT7_RUNTIME_KEY, undefined);
      assert.equal(command, 'pnpm');
      assert.deepEqual(args, [
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        '4173',
        '--strictPort',
      ]);
      return {
        isRunning: () => true,
        async stop() {
          stopped = true;
        },
      };
    },
    async waitForServer(server) {
      assert.equal(server.isRunning(), true);
    },
    async runCommand(command, args, settings) {
      calls.push({ command, args, settings });
      assert.equal(command, 'agent-browser');
      assert.equal(settings.cwd, home);
      assert.equal(settings.env.HOME, home);
      assert.equal(settings.maxBuffer, 65536);
      assert.ok(settings.timeout > 0 && settings.timeout <= 15000);
      assert.equal(await readFile(args[1], 'utf8'), '{}');
      const action = args.slice(6);
      if (action[0] === 'open')
        assert.equal(action[1], 'http://127.0.0.1:4173/');
      if (action[0] === 'get' && action[1] === 'title') return 'Todo app';
      if (action[0] === 'snapshot') return '- textbox "Title"\n- button "Add"';
      if (action[0] === 'find' && action[1] === 'label') todo = action[4];
      if (action[0] === 'get' && action[1] === 'text') return `Todos\n${todo}`;
      return '';
    },
    ...overrides,
  };
  return {
    options,
    calls,
    get home() {
      return home;
    },
    get stopped() {
      return stopped;
    },
  };
}

test('browser smoke uses isolated localhost session and verifies create plus persistence', async () => {
  const f = fixture();
  const result = await runBrowserQa(f.options);
  assert.equal(result.status, 'passed');
  assert.ok(result.checks.every((check) => check.status === 'passed'));
  const { observations, ...flags } = result.evidence;
  assert.ok(Object.values(flags).every((value) => value === true));
  assert.equal(observations.title, 'Todo app');
  assert.match(observations.snapshot, /textbox/);
  assert.equal(observations.snapshotTruncated, false);
  const browserCalls = f.calls.filter(
    (call) => call.command === 'agent-browser',
  );
  assert.equal(new Set(browserCalls.map((call) => call.args[3])).size, 1);
  assert.ok(
    browserCalls.every(
      (call) =>
        call.args[4] === '--allowed-domains' && call.args[5] === '127.0.0.1',
    ),
  );
  assert.ok(browserCalls.some((call) => call.args[6] === 'reload'));
  assert.ok(browserCalls.some((call) => call.args[6] === 'screenshot'));
  assert.equal(browserCalls.at(-1).args[6], 'close');
  assert.equal(f.stopped, true);
  await assert.rejects(access(f.home));
  assert.doesNotMatch(JSON.stringify(result), /Browser smoke|\/tmp|ghai-qa/);
});

test('failed checks stop later actions and never return raw browser errors', async () => {
  const f = fixture();
  const original = f.options.runCommand;
  f.options.runCommand = async (...args) => {
    if (args[1][6] === 'snapshot') throw new Error('PRIVATE TOKEN RAW HTML');
    return original(...args);
  };
  const result = await runBrowserQa(f.options);
  assert.equal(result.status, 'failed');
  assert.equal(
    result.checks.find((check) => check.check === 'page-rendered').status,
    'failed',
  );
  assert.equal(
    result.checks.find((check) => check.check === 'add-todo').status,
    'not-run',
  );
  assert.equal(f.calls.at(-1).args[6], 'close');
  assert.equal(f.stopped, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|TOKEN|HTML/);
  await assert.rejects(access(f.home));
});

test('server startup failure cleans up and never opens browser', async () => {
  const f = fixture({
    async waitForServer() {
      throw new Error('private logs');
    },
  });
  const result = await runBrowserQa(f.options);
  assert.equal(result.checks[0].status, 'failed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.stopped, true);
  await assert.rejects(access(f.home));
});

test('oversized output and missing controls fail closed', async () => {
  for (const value of ['x'.repeat(65537), '- textbox "Other"']) {
    const f = fixture();
    const original = f.options.runCommand;
    f.options.runCommand = async (...args) =>
      args[1][6] === 'snapshot' ? value : original(...args);
    const result = await runBrowserQa(f.options);
    assert.equal(result.status, 'failed');
    assert.equal(result.evidence.controlsPresent, false);
    assert.equal(f.stopped, true);
  }
});

test('lost persistence fails and browser cleanup failure still stops server', async () => {
  const f = fixture();
  let reloaded = false;
  const original = f.options.runCommand;
  f.options.runCommand = async (...args) => {
    const action = args[1].slice(6);
    if (action[0] === 'reload') reloaded = true;
    if (reloaded && action[0] === 'get') return 'No tasks';
    if (action[0] === 'close') throw new Error('private failure');
    return original(...args);
  };
  const result = await runBrowserQa(f.options);
  assert.equal(result.status, 'failed');
  assert.equal(
    result.checks.find((check) => check.check === 'refresh-persistence').status,
    'failed',
  );
  assert.equal(result.checks.at(-1).status, 'failed');
  assert.equal(f.stopped, true);
  await assert.rejects(access(f.home));
});

test('each smoke run has its own browser session', async () => {
  const a = fixture();
  const b = fixture();
  await runBrowserQa(a.options);
  await runBrowserQa(b.options);
  assert.notEqual(a.calls[1].args[3], b.calls[1].args[3]);
  assert.notEqual(a.home, b.home);
});

test('whole-QA deadline aborts a stuck command and still closes browser/server', async () => {
  const f = fixture();
  const original = f.options.runCommand;
  let aborted = false;
  f.options.runCommand = async (...args) => {
    if (args[1][6] === 'snapshot') {
      args[2].signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise(() => {});
    }
    return original(...args);
  };
  const started = Date.now();
  const result = await runBrowserQa({ ...f.options, timeoutMs: 1000 });
  assert.equal(result.status, 'failed');
  assert.equal(aborted, true);
  assert.equal(f.stopped, true);
  assert.equal(f.calls.at(-1).args[6], 'close');
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(access(f.home));
});

test('invalid timeout fails before any process is started', async () => {
  const f = fixture();
  const result = await runBrowserQa({ ...f.options, timeoutMs: Infinity });
  assert.equal(result.status, 'failed');
  assert.equal(f.calls.length, 0);
});

test('private semantic observations are bounded and include the final refreshed snapshot', async () => {
  const f = fixture();
  const original = f.options.runCommand;
  let snapshots = 0;
  f.options.runCommand = async (...args) => {
    const action = args[1].slice(6);
    if (action[0] === 'get' && action[1] === 'title')
      return 'Todo ' + '界'.repeat(200);
    if (action[0] === 'snapshot') {
      snapshots++;
      if (snapshots === 2)
        return (
          '- combobox "Assignee"\n- textbox "Due"\n- textbox "Reminder"\u0000' +
          '界'.repeat(3000)
        );
    }
    return original(...args);
  };
  const result = await runBrowserQa(f.options);
  assert.equal(result.status, 'passed');
  const observations = result.evidence.observations;
  assert.ok(Buffer.byteLength(observations.title) <= 200);
  assert.ok(Buffer.byteLength(observations.snapshot) <= 6000);
  assert.equal(observations.titleTruncated, true);
  assert.equal(observations.snapshotTruncated, true);
  assert.match(observations.snapshot, /Assignee/);
  assert.match(observations.snapshot, /Reminder/);
  assert.doesNotMatch(observations.snapshot, /\u0000/);
  assert.equal(snapshots, 2);
});
