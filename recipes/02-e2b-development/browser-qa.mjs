// Trusted smoke checks, not an agent-controlled browser loop. No credentials needed.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const url = 'http://127.0.0.1:4173/';
const outputLimit = 64 * 1024;
const commandTimeoutMs = 15_000;
const checkNames = [
  'server-ready',
  'page-rendered',
  'add-todo',
  'refresh-persistence',
  'screenshot',
  'cleanup',
];

async function execute(command, args, options) {
  const { stdout } = await execFileAsync(command, args, {
    ...options,
    encoding: 'utf8',
    timeout: options.timeout ?? commandTimeoutMs,
    maxBuffer: outputLimit,
    killSignal: 'SIGKILL',
  });
  return stdout;
}

function launchServer(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: 'ignore',
  });
  let failed = false;
  child.once('error', () => {
    failed = true;
  });
  return {
    isRunning: () =>
      !failed && child.exitCode === null && child.signalCode === null,
    async stop() {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    },
  };
}

async function awaitServer(server, { signal }) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (!server.isRunning()) throw new Error('Server stopped');
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        redirect: 'error',
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('Server not ready');
}

// Dependencies are injectable for credential-free tests; defaults execute real tools.
// A fresh HOME and session isolate browser configuration, cookies and localStorage.
// Screenshots are private temporary files and are always removed. Bounded title/
// accessibility observations are untrusted private input for the decision call only;
// callers must not persist them in public checks or results.
export async function runBrowserQa({
  appDir,
  timeoutMs = 120_000,
  runCommand = execute,
  startServer = launchServer,
  waitForServer = awaitServer,
} = {}) {
  const checks = checkNames.map((check) => ({ check, status: 'not-run' }));
  const validBudget =
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1000 &&
    timeoutMs <= 3_600_000;
  const deadline = Date.now() + (validBudget ? timeoutMs : 1000);
  const workDeadline = deadline - Math.min(2000, Math.floor(timeoutMs / 4));
  async function bounded(operation, end = workDeadline) {
    const remaining = Math.min(commandTimeoutMs, end - Date.now());
    if (remaining <= 0) throw new Error('QA deadline');
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          operation({ signal: controller.signal, timeout: remaining }),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('QA deadline'));
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const evidence = {
    titleMatches: false,
    controlsPresent: false,
    todoVisible: false,
    todoPersists: false,
    screenshotCaptured: false,
    observations: {
      title: '',
      snapshot: '',
      titleTruncated: false,
      snapshotTruncated: false,
    },
  };
  function observe(field, value, maxBytes) {
    const cleaned = value
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
      .trim();
    let text = '';
    let bytes = 0;
    for (const character of cleaned) {
      const size = Buffer.byteLength(character);
      if (bytes + size > maxBytes) break;
      text += character;
      bytes += size;
    }
    evidence.observations[field] = text;
    evidence.observations[`${field}Truncated`] = text.length < cleaned.length;
  }
  let directory;
  let server;
  let browser;
  let index = 0;
  let browserAttempted = false;
  try {
    if (!validBudget) throw new Error('Invalid QA budget');
    if (typeof appDir !== 'string' || !appDir) throw new Error('Missing app');
    directory = await mkdtemp(join(tmpdir(), 'ghai-browser-qa-'));
    const env = {
      PATH: '/opt/ghai-delegation/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      XDG_CACHE_HOME: directory,
      // Browser binaries are provisioned by the trusted template, not installed here.
      AGENT_BROWSER_EXECUTABLE_PATH: '/opt/ghai-delegation/bin/chrome',
      CI: '1',
    };
    const options = { cwd: resolve(appDir), env };
    const session = `ghai-qa-${randomUUID()}`;
    // Use a trusted empty config rather than discovering config in generated code.
    const config = join(directory, 'browser-config.json');
    await writeFile(config, '{}', { mode: 0o600 });
    browser = async (...args) => {
      const result = await bounded(
        (limits) =>
          runCommand(
            'agent-browser',
            [
              '--config',
              config,
              '--session',
              session,
              '--allowed-domains',
              '127.0.0.1',
              ...args,
            ],
            { ...options, cwd: directory, ...limits, maxBuffer: outputLimit },
          ),
        args[0] === 'close' ? deadline : workDeadline,
      );
      if (typeof result !== 'string' || Buffer.byteLength(result) > outputLimit)
        throw new Error('Browser output limit');
      return result;
    };
    server = await startServer(
      'pnpm',
      ['dev', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
      options,
    );
    await bounded((limits) => waitForServer(server, limits));
    checks[index++].status = 'passed';

    browserAttempted = true;
    await browser('open', url);
    await browser('wait', '--load', 'domcontentloaded');
    const title = await browser('get', 'title');
    observe('title', title, 200);
    const snapshot = await browser('snapshot');
    observe('snapshot', snapshot, 6000);
    evidence.titleMatches = /todo/i.test(title);
    evidence.controlsPresent =
      /textbox "Title"/.test(snapshot) && /button "Add"/.test(snapshot);
    if (!evidence.titleMatches || !evidence.controlsPresent)
      throw new Error('App contract');
    checks[index++].status = 'passed';

    const todo = `Browser smoke ${randomUUID()}`;
    await browser('find', 'label', 'Title', 'fill', todo, '--exact');
    await browser(
      'find',
      'role',
      'button',
      'click',
      '--name',
      'Add',
      '--exact',
    );
    await browser('find', 'text', todo, 'text', '--exact');
    evidence.todoVisible = (await browser('get', 'text', 'body')).includes(
      todo,
    );
    if (!evidence.todoVisible) throw new Error('Todo absent');
    checks[index++].status = 'passed';

    await browser('reload');
    await browser('find', 'text', todo, 'text', '--exact');
    evidence.todoPersists = (await browser('get', 'text', 'body')).includes(
      todo,
    );
    if (!evidence.todoPersists) throw new Error('Todo not persisted');
    observe('snapshot', await browser('snapshot'), 6000);
    checks[index++].status = 'passed';

    await browser('screenshot', join(directory, 'smoke.png'));
    evidence.screenshotCaptured = true;
    checks[index++].status = 'passed';
  } catch {
    checks[index].status = 'failed';
  } finally {
    let cleaned = true;
    if (browserAttempted) {
      try {
        await browser('close');
      } catch {
        cleaned = false;
      }
    }
    if (server) {
      try {
        await server.stop();
      } catch {
        cleaned = false;
      }
    }
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        cleaned = false;
      }
    }
    checks.at(-1).status = cleaned ? 'passed' : 'failed';
  }
  return {
    status: checks.every((check) => check.status === 'passed')
      ? 'passed'
      : 'failed',
    checks,
    evidence,
  };
}
