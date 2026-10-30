import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitFixture } from './git-fixture.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkerResult, readWorkerResult, recoverWorkerText } from './factory-ui/worker-result-recovery.mjs';
import { eligibleContinuations } from './factory-ui/planning-revalidation.mjs';
const result = {
  outcome: 'completed',
  implementation_complete: true,
  summary: 'Done',
  evidence: 'retained',
  remaining: [],
  artifacts: [],
};
const service = (cli) => ({ codex: cli, store: { update: (run, fields) => Object.assign(run, fields) } });
test('malformed final JSON is corrected once without another implementation assignment', async () => {
  let turns = 0;
  const cli = {
    turn: async (_id, _cwd, prompt) => {
      turns++;
      assert.match(prompt, /Do not run tools/);
      return JSON.stringify(result);
    },
  };
  const run = { threadId: 'same-chat' };
  assert.deepEqual(await readWorkerResult(service(cli), run, '{bad'), result);
  assert.equal(turns, 1);
  assert.equal(run.rejectedWorkerResult, '{bad');
});
test('a failed correction retains a clean commit for draft handoff without claiming implementation complete', async (t) => {
  const { root, git } = gitFixture(t, 'result-recovery-');
  writeFileSync(join(root, 'one'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'one'), 'changed');
  git('commit', '-qam', 'candidate');
  let turns = 0;
  const cli = {
    turn: async () => {
      turns++;
      return 'bad';
    },
  };
  const run = { checkout: root, base, deliveryMode: 'draft-handoff' };
  const recovered = await readWorkerResult(service(cli), run, 'bad');
  assert.equal(turns, 1);
  assert.equal(recovered.implementation_complete, false);
  assert.match(recovered.summary, /unverified/);
  await readWorkerResult(service(cli), run, 'bad');
  assert.equal(turns, 1);
  run.deliveryMode = 'verified-delivery';
  await assert.rejects(readWorkerResult(service(cli), run, 'bad'), /cannot be weakened/);
});
test('transport recovery observes the exact original turn and never starts another turn', async () => {
  const cli = {
    ready: async () => {},
    resume: async () => {},
    call: async (_method, args) => {
      assert.equal(args.threadId, 'original');
      return {
        data: [{ id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify(result) }] }],
      };
    },
  };
  const run = { kind: 'worker', threadId: 'original', events: [{ params: { turnId: 'turn' } }] };
  const recovered = await recoverWorkerText(service(cli), run, Error('Codex disconnected'), { connection: cli });
  assert.deepEqual(parseWorkerResult(recovered.text), result);
  assert.equal(run.recoveredTurnId, 'turn');
});
test('running or unidentified turns cannot become a draft or duplicate worker', async () => {
  const cli = {
    ready: async () => {},
    resume: async () => {},
    call: async () => ({ data: [{ id: 'turn', status: 'inProgress' }] }),
  };
  await assert.rejects(
    recoverWorkerText(service(cli), { kind: 'worker', threadId: 'same', events: [] }, Error('disconnected'), {
      connection: cli,
    }),
    /Cannot identify/
  );
  await assert.rejects(
    recoverWorkerText(
      service(cli),
      { kind: 'worker', threadId: 'same', completedTurnId: 'turn' },
      Error('disconnected'),
      { connection: cli, waitMs: 0 }
    ),
    /has not completed/
  );
});
test('only actual blocked worker assignments are eligible continuations', () => {
  const s = {
    store: {
      runs: [{ actionId: 'worker-action', kind: 'worker', threadId: 'chat', status: 'blocked' }],
      connected: new Set(),
    },
  };
  const queue = {
    actions: [
      { id: 'skip-run', issues: ['one'], status: 'blocked' },
      { id: 'worker-action', issues: ['one'], status: 'blocked' },
    ],
  };
  assert.deepEqual(
    eligibleContinuations(s, queue, 'one').map((x) => x.action_id),
    ['worker-action']
  );
  s.store.connected.add('unknown');
  queue.actions[1].issues.push('other');
  assert.deepEqual(eligibleContinuations(s, queue, 'one'), []);
});

test('protocol corruption retains a bounded fingerprint without exposing raw output', async () => {
  const { CodexConnection } = await import('./factory-ui/codex.mjs');
  const cli = new CodexConnection();
  let error;
  cli.fail = (value) => {
    error = value;
  };
  cli.receive('malformed sensitive wire output');
  assert.equal(error.recovery.code, 'CODEX_PROTOCOL_INVALID');
  assert.equal(error.recovery.sha256.length, 64);
  assert.equal(error.recovery.bytes, 31);
  assert.doesNotMatch(JSON.stringify(error.recovery), /sensitive/);
});
