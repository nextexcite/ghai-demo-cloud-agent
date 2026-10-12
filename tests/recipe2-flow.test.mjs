import './offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runQaFlow } from '../recipes/02-e2b-development/remote-runner.mjs';
const job = { budget: { maxWallTimeMs: 900000, maxObservedTurns: 40 } };
const checks = () =>
  ['lint', 'typecheck', 'test', 'build'].map((check) => ({
    check,
    status: 'passed',
  }));
const browser = async () => ({
  checks: [{ check: 'browser', status: 'passed' }],
  evidence: { todoPersists: true },
});
test('complete flow shares allowance and makes at most one repair', async () => {
  const allocations = [];
  let n = 0;
  const result = await runQaFlow(job, {
    implement: async (b) => {
      allocations.push(b);
      return { observedTurns: 6 };
    },
    check: async () => checks(),
    browser,
    decide: async (e) => {
      assert.equal(e.repairRemaining, n === 0);
      return {
        action: ++n === 1 ? 'repair' : 'ready_for_review',
        focus: 'assignee',
      };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.observedTurns, 12);
  assert.equal(allocations[1].maxObservedTurns, 34);
  assert.equal(allocations[1].repair.investigateCriterion, 'assignee');
  assert.equal(result.rounds.length, 2);
});
test('failed checks cannot be waived even by a malformed ready decision', async () => {
  await assert.rejects(
    runQaFlow(job, {
      implement: async () => ({ observedTurns: 1 }),
      check: async () => [{ check: 'test', status: 'failed' }],
      browser,
      decide: async () => ({ action: 'ready_for_review' }),
    }),
    /cannot be waived/,
  );
});
test('second repair request stops for human instead of looping', async () => {
  const result = await runQaFlow(job, {
    implement: async () => ({ observedTurns: 1 }),
    check: async () => checks(),
    browser,
    decide: async () => ({ action: 'repair' }),
  });
  assert.equal(result.status, 'needs_human');
  assert.equal(result.rounds.length, 2);
});
test('whole-job time and turn exhaustion stop before another agent', async () => {
  let time = 0;
  await assert.rejects(
    runQaFlow(job, {
      now: () => time,
      implement: async () => {
        time = 900001;
        return { observedTurns: 1 };
      },
      check: async () => checks(),
      browser,
      decide: async () => ({ action: 'repair' }),
    }),
    /budget exhausted/,
  );
  await assert.rejects(
    runQaFlow(
      { ...job, budget: { ...job.budget, maxObservedTurns: 1 } },
      {
        implement: async () => ({ observedTurns: 1 }),
        check: async () => checks(),
        browser,
        decide: async () => ({ action: 'repair' }),
      },
    ),
    /budget exhausted/,
  );
});

test('a decision completing after the whole-job deadline cannot release output', async () => {
  let time = 0;
  await assert.rejects(
    runQaFlow(job, {
      now: () => time,
      implement: async () => ({ observedTurns: 1 }),
      check: async () => checks(),
      browser,
      decide: async () => {
        time = 900001;
        return { action: 'ready_for_review' };
      },
    }),
    /budget exhausted/,
  );
});
