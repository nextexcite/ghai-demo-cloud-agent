import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
const dir = new URL('../.github/workflows/', import.meta.url);
assert.deepEqual(
  readdirSync(dir),
  ['pi-review.yml'],
  'Only manual workflow is approved',
);
const workflow = parse(readFileSync(new URL('pi-review.yml', dir), 'utf8'));
assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
assert.equal(
  workflow.on.workflow_dispatch.inputs.allow_inference.default,
  false,
);
assert.deepEqual(workflow.permissions, {
  contents: 'read',
  'pull-requests': 'read',
});
assert.equal(
  workflow.jobs.review.if,
  "github.ref == 'refs/heads/main' && github.run_attempt == 1 && inputs.allow_inference",
);
assert.equal(workflow.jobs.review['runs-on'], 'ubuntu-24.04');
assert.equal(workflow.jobs.review.env.GIT_CONFIG_COUNT, '1');
assert.equal(workflow.jobs.review.env.GIT_CONFIG_KEY_0, 'init.defaultBranch');
assert.equal(workflow.jobs.review.env.GIT_CONFIG_VALUE_0, 'main');
const steps = workflow.jobs.review.steps;
for (const step of steps.filter((step) => step.uses))
  assert.match(step.uses, /^[\w/-]+@[a-f0-9]{40}$/);
const checkout = steps.find((step) =>
  step.uses?.startsWith('actions/checkout@'),
);
assert.equal(checkout.with.ref, '${{ github.sha }}');
assert.equal(checkout.with['persist-credentials'], false);
const prepare = steps.find((step) => step.id === 'prepare');
for (const step of steps.filter((step) =>
  ['prepare', 'primary', 'fallback'].includes(step.id),
)) {
  for (const name of [
    'GHAI_PI_BASE_URL',
    'GHAI_PI_PRIMARY_MODEL',
    'GHAI_PI_FALLBACK_MODEL',
  ])
    assert.equal(step.env[name], '${{ secrets.' + name + ' }}');
}
for (const step of steps.filter(
  (step) => !['prepare', 'primary', 'fallback'].includes(step.id),
))
  assert(
    !Object.keys(step.env ?? {}).some((name) => name.startsWith('GHAI_PI_')),
  );
const agents = steps.filter((step) => step.uses?.startsWith('shaftoe/'));
assert.equal(agents.length, 2);
for (const step of agents) {
  assert.equal(
    step.uses,
    'shaftoe/pi-coding-agent-action@f7496a9aea9798c5d52d39096d98d5c5b16559b3',
  );
  assert.equal(step.with.provider, 'ghai');
  assert.equal(step.with.model, step.id);
  assert.equal(step.env.GHAI_REVIEW_MODEL, step.id);
  assert.equal(
    step.with.prompt,
    'Review the prepared bounded patch using the trusted extension.',
  );
  assert.equal(step.with.loaded_tools, 'ghai_review_disabled');
  for (const key of [
    'load_builtin_extensions',
    'enable_codemode',
    'enable_tool_search',
    'auto_compaction',
    'refresh_model_catalog',
    'export_session_html',
    'export_session_jsonl',
    'share_session',
  ])
    assert.equal(step.with[key], false);
  assert.equal(step.with.cache_warming, 'off');
  for (const key of ['pr_number', 'token', 'mcp_servers'])
    assert(!Object.hasOwn(step.with, key));
  assert.equal(step.env.PI_OFFLINE, '1');
  assert.equal(step.env.GHAI_API_KEY, '${{ secrets.GHAI_API_KEY }}');
  assert.equal(step.env.HOME, '${{ steps.prepare.outputs.root }}/home');
  assert.equal(
    step.env.PI_CODING_AGENT_DIR,
    '${{ steps.prepare.outputs.root }}/agent',
  );
}
assert.equal(agents[1].if, "steps.primary_state.outputs.next == 'fallback'");
const artifacts = steps.find((step) =>
  step.uses?.startsWith('actions/upload-artifact@'),
);
assert.deepEqual(
  artifacts.with.path
    .trim()
    .split('\n')
    .map((line) => line.split('/').pop()),
  [
    'plan.json',
    'provenance.json',
    'attempts.jsonl',
    'report.json',
    'review.md',
  ],
);
assert(
  !existsSync(new URL('../.pi', import.meta.url)),
  'No project Pi auto-loading configuration',
);
console.log(
  'Manual-only workflow, SHA pins, isolation, no-tools, output and permissions policy passed.',
);
