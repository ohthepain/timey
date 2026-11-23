import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexConnection } from './factory-ui/codex.mjs';
import { readCodexQuota } from './factory-ui/codex-quota.mjs';
import { git } from './factory-ui/common.mjs';
import {
  countStoreRead,
  beginActivity,
  recordActivity,
  resetCodexActivity,
  observeActivity,
  readDiagnosticActivity,
  withDiagnosticContext,
} from './factory-ui/diagnostic-activity.mjs';

const totals = (inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  reasoningOutputTokens,
});

test('diagnostics attribute resumed turn totals and keep repeated-input metadata without content', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'timey-diagnostics-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.XDG_STATE_HOME = directory;
  const connection = new CodexConnection();
  connection.call = async () => ({ turn: { id: 'turn' } });
  const finish = (status) =>
    connection.event({ method: 'turn/completed', params: { threadId: 'thread', turn: { status } } });
  const usage = (total, last) =>
    connection.event({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread', tokenUsage: { total, last } },
    });
  const prompt = 'private input should never be stored';
  const scopedTurn = (attemptId) =>
    withDiagnosticContext(directory, { issueId: 'issue-1', step: 'work', blockId: 'block', attemptId }, () =>
      connection.turn('thread', directory, prompt, undefined, [], { model: 'test-model' })
    );
  const first = scopedTurn('one');
  usage(totals(1050, 320, 125, 62), totals(50, 20, 25, 12));
  connection.event({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread', itemId: 'output', delta: 'fixture' },
  });
  usage(totals(1080, 330, 140, 70), totals(30, 10, 15, 8));
  finish('completed');
  await first;
  const second = scopedTurn('two');
  usage(totals(1100, 330, 150, 73), totals(20, 0, 10, 3));
  finish('interrupted');
  await assert.rejects(second);
  const [retry, original] = readDiagnosticActivity().rows;
  assert.equal(original.issueId, 'issue-1');
  assert.equal(original.step, 'work');
  assert.equal(original.model, 'test-model');
  assert.ok(original.firstOutputMs >= 0);
  assert.deepEqual(original.usage, totals(80, 30, 40, 20));
  assert.deepEqual(retry.usage, totals(20, 0, 10, 3));
  assert.equal(retry.status, 'interrupted');
  assert.equal(retry.inputFingerprint, original.inputFingerprint);
  assert.equal(JSON.stringify(readDiagnosticActivity()).includes(prompt), false);

  countStoreRead(directory, 'Cached views');
  countStoreRead(directory, 'Joined refreshes');
  await observeActivity('stores', 'Refresh stores', {}, async () => 1);
  await assert.rejects(
    observeActivity('verification', 'Verify', { candidate: 'fixture' }, async () => {
      throw Error('private data');
    })
  );
  assert.throws(() => git(directory, 'worktree', 'list'));
  const activity = readDiagnosticActivity();
  assert.ok(activity.rows.some((entry) => entry.category === 'git' && entry.status === 'Failed'));
  assert.ok(activity.rows.some((entry) => entry.category === 'verification' && entry.status === 'Failed'));
  assert.ok(activity.rows.some((entry) => entry.category === 'stores' && entry.status === 'Completed'));
  assert.deepEqual(Object.values(activity.stores), [{ 'Cached views': 1, 'Joined refreshes': 1 }]);
  assert.equal(JSON.stringify(activity).includes('private data'), false);
  assert.equal(activity.codexTotal, 2);
  for (let index = 0; index < 125; index++) {
    recordActivity('codex', { startedAt: Date.now(), status: 'completed' });
  }
  assert.equal(readDiagnosticActivity().codexTotal, 127);
  assert.equal(readDiagnosticActivity().rows.filter((row) => row.category === 'codex').length, 120);
  const finishOld = beginActivity('codex', 'Already running');
  const cleared = resetCodexActivity();
  assert.equal(cleared.codexTotal, 0);
  assert.ok(cleared.rows.every((row) => row.category !== 'codex'));
  assert.ok(cleared.rows.some((row) => row.category === 'verification'));
  finishOld('Completed');
  assert.equal(readDiagnosticActivity().codexTotal, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  beginActivity('codex', 'After reset')('Completed');
  assert.equal(readDiagnosticActivity().codexTotal, 1);
});

test('Codex quota uses the active login and only returns reported allowance windows', async () => {
  const methods = [];
  let closed = 0;
  const quota = await readCodexQuota({
    force: true,
    connect: () => ({
      ready: async () => {},
      async call(method) {
        methods.push(method);
        if (method === 'account/read')
          return { account: { type: 'chatgpt', planType: 'pro', email: 'private@example.test' } };
        return {
          rateLimitsByLimitId: {
            codex: {
              limitId: 'codex',
              primary: { usedPercent: 87, windowDurationMins: 300, resetsAt: 1800000000 },
              secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1800200000 },
            },
          },
        };
      },
      close: () => closed++,
    }),
  });
  assert.equal(closed, 1);
  assert.deepEqual(methods, ['account/read', 'account/rateLimits/read']);
  assert.deepEqual(
    quota.limits[0].windows.map((window) => window.remainingPercent),
    [13, 73]
  );
  assert.equal(JSON.stringify(quota).includes('private@example.test'), false);
  assert.equal((await readCodexQuota()).checkedAt, quota.checkedAt);
  const keyed = await readCodexQuota({
    force: true,
    connect: () => ({
      ready: async () => {},
      async call(method) {
        assert.equal(method, 'account/read');
        return { account: { type: 'apiKey' } };
      },
      close: () => {},
    }),
  });
  assert.equal(keyed.status, 'api-key');
});
