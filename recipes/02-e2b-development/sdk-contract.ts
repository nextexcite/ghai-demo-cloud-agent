// Typechecked against the installed exact E2B SDK. Not executed by offline tests.
import { Sandbox, type SandboxOpts } from 'e2b';
const options = {
  apiKey: 'not-a-real-key',
  domain: 'e2b.app',
  apiUrl: 'https://api.e2b.app',
  sandboxUrl: 'https://sandbox.e2b.app',
  debug: false,
  retries: 0,
  timeoutMs: 1000,
  lifecycle: { onTimeout: 'kill' },
  metadata: { jobId: 'test' },
  network: {
    allowPublicTraffic: false,
    denyOut: ['0.0.0.0/0'],
    allowOut: ['github.com'],
  },
} satisfies SandboxOpts;
export async function contract() {
  const sandbox = await Sandbox.create('template:build', options);
  await sandbox.files.write([{ path: '/tmp/job.json', data: '{}' }]);
  const info = await sandbox.files.getInfo('/tmp/patch');
  const size: number = info.size;
  const text: string = await sandbox.files.read('/tmp/patch');
  const output = await sandbox.commands.run('true', {
    timeoutMs: 1000,
    envs: { EXAMPLE: 'value' },
  });
  const exitCode: number = output.exitCode;
  const pager = Sandbox.list({
    ...options,
    query: { metadata: { jobId: 'test' } },
  });
  while (pager.hasNext) await pager.nextItems();
  await sandbox.kill();
  await Sandbox.kill(sandbox.sandboxId, options);
  return { size, text, exitCode };
}
