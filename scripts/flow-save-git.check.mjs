import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { openIssueStore, openRecordStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createArtifactRouter } from './factory-ui/stores/coordination.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';

function traceCounts(path) {
  const commands = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
    .filter((event) => event.event === 'start' && event.argv[0] === 'git');
  return {
    advertisedHeads: commands.filter(({ argv }) => argv.includes('ls-remote')).length,
    pushes: commands.filter(({ argv }) => argv.includes('push')).length,
  };
}

async function savingFlow(t, output, maximumHeads) {
  const { root, git } = gitFixture(t, 'flow-save-git-');
  writeFileSync(join(root, 'source.txt'), 'Committed source\n');
  git('add', 'source.txt');
  git('commit', '-qm', 'Source');
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  git('remote', 'add', 'origin', remote);
  const options = { root, projectId: 'flow-save-fixture' };
  const physical = await openArtifactStore({ id: 'artifacts', kind: 'files' }, options);
  let records;
  const artifacts = createArtifactRouter({ active: physical, records: () => records });
  const config = { id: 'coordination', kind: 'git', branch: 'queue' };
  const issues = await openIssueStore({ id: 'issues', kind: 'files' }, { ...options, artifacts });
  records = await openRecordStore(config, { ...options, artifacts });
  const create = (coordination, runnerId) =>
    createProjectStores({
      ...options,
      records: coordination,
      artifacts,
      issueStores: { issues },
      runnerId,
    });
  const project = create(records, 'runner-a');
  const issueId = '20261123-rebuild';
  const flow = {
    version: 1,
    issueId,
    revision: 1,
    routeType: 'investigation',
    blocks: [
      { id: 'request', kind: 'request', after: [], attempts: [], data: { wording: 'Rebuild this flow.' } },
      {
        id: 'work',
        kind: 'investigate',
        after: ['request'],
        attempts: [{ id: 'finished', status: 'completed', output }],
      },
      { id: 'report', kind: 'generate-report', after: ['work'], attempts: [] },
      { id: 'issues', kind: 'create-issues', after: ['report'], attempts: [] },
    ],
  };
  await project.importIssue({
    id: issueId,
    report: `---\nid: ${issueId}\ntitle: Rebuild\nstate: backlog\n---\n\nOriginal words.\n`,
    flow,
    storeId: 'issues',
    operationId: 'import-rebuild',
  });
  let current = (await project.readIssue(issueId)).flow;
  const trace = join(root, 'git.trace');
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    records = await openRecordStore(config, { ...options, artifacts });
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }
  const writer = create(records, 'runner-a');
  const measurements = [];
  for (let index = 0; index < 5; index++) {
    const outputs = current.blocks.slice(2).toReversed();
    const changed = {
      ...current,
      blocks: [
        ...current.blocks.slice(0, 2),
        ...outputs.map((block, position) => ({ ...block, after: [position ? outputs[position - 1].id : 'work'] })),
      ],
    };
    writeFileSync(trace, '');
    const operationId = 'rebuild-' + index;
    current = await writer.saveFlow({ issueId, flow: changed, expectedRevision: changed.revision, operationId });
    measurements.push(traceCounts(trace));
    assert.equal(current.revision, changed.revision + 1);
    assert.deepEqual(current.blocks, changed.blocks);
    assert.deepEqual(
      current.blocks.slice(2).map(({ id }) => id),
      index % 2 ? ['report', 'issues'] : ['issues', 'report']
    );
    assert.equal(await records.get('claims/' + issueId), null);
    const repeated = await writer.saveFlow({ issueId, flow: changed, expectedRevision: changed.revision, operationId });
    assert.deepEqual(repeated, current, 'Retrying the same operation returns the saved flow without another revision.');
  }
  const peerRecords = await openRecordStore(config, { ...options, artifacts });
  const peer = create(peerRecords, 'runner-b');
  const peerFlow = { ...current, peer: true };
  const peerSaved = await peer.saveFlow({
    issueId,
    flow: peerFlow,
    expectedRevision: peerFlow.revision,
    operationId: 'peer-change',
  });
  assert.deepEqual((await writer.readIssue(issueId)).flow, peerSaved, 'A later ordinary read observes the peer save.');
  await assert.rejects(
    writer.saveFlow({ issueId, flow: current, expectedRevision: current.revision, operationId: 'stale-change' }),
    { code: 'STORE_CONFLICT' }
  );
  t.diagnostic(
    JSON.stringify({
      outputBytes: Buffer.byteLength(output),
      saves: measurements.length,
      verifiedSaves: measurements.length,
      measurements,
    })
  );
  for (const measurement of measurements) {
    assert.ok(measurement.advertisedHeads <= maximumHeads, 'A flow save must not reopen the Git head for each record.');
    assert.equal(measurement.pushes, 1, 'A flow save confirms its flow and operation in one publication.');
  }
}

test('saving an inline rebuilt flow uses bounded Git round trips and retains fresh authority', (t) =>
  savingFlow(t, 'Retained investigation evidence.\n', 3));

test('saving an overflow rebuilt flow uses bounded Git round trips and retains fresh authority', (t) =>
  savingFlow(t, 'Retained investigation evidence.\n'.repeat(2000), 7));
