import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRecordStore, openIssueStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';
import { registerProjectStores, commitStoredReport } from './factory-ui/stores/report-access.mjs';
import { updateStoredIssueMetadata, moveStoredIssue } from './factory-ui/issue-report-storage.mjs';
import { appendCompletion } from './factory-completion.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-report-authority-'));
  mkdirSync(join(root, '.issues'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { root, projectId: 'writer-fixture' };
  const artifacts = await openArtifactStore({ id: 'artifacts', kind: 'files' }, options);
  const records = await openRecordStore({ id: 'coordination', kind: 'files' }, { ...options, artifacts });
  const issues = await openIssueStore({ id: 'issues', kind: 'files' }, { ...options, artifacts });
  const stores = createProjectStores({
    ...options,
    runnerId: 'fixture-runner',
    records,
    issueStores: new Map([['issues', issues]]),
    artifacts,
  });
  const id = '20261122-authoritative-report';
  const content = `---\nid: ${id}\ntitle: Original\nstate: backlog\nunknown: preserve\n---\n\nOriginal request.\n`;
  await stores.importIssue({ id, number: 1, report: content, storeId: 'issues', operationId: 'import' });
  await stores.refresh();
  const unregister = registerProjectStores(root, stores);
  t.after(unregister);
  return { root, stores, issues, id, content, issue: { id, content, location: 'open', state: 'backlog' } };
}

test('metadata and completion wait for real canonical Issue commits before refreshing report projections', async (t) => {
  const f = await fixture(t);
  await updateStoredIssueMetadata(f.root, f.issue, { title: 'Canonical title' });
  const saved = await f.stores.readIssue(f.id);
  assert.match(saved.report, /title: Canonical title/);
  assert.match(saved.report, /unknown: preserve/);
  assert.equal(readFileSync(join(f.root, '.issues', f.id + '.md'), 'utf8'), saved.report);
  await appendCompletion(
    f.root,
    { ...f.issue, content: saved.report },
    { summary: 'Checked', notes: 'Retained existing proof.', remaining: [], stage_records: [] },
    { authorization: { kind: 'direct-user', operation: 'record-completion' } },
    [],
    null
  );
  const completed = await f.stores.readIssue(f.id);
  assert.match(completed.report, /Retained existing proof/);
  assert.equal(readFileSync(join(f.root, '.issues', f.id + '.md'), 'utf8'), completed.report);
});

test('stale expected report never overwrites canonical content or its last confirmed projection', async (t) => {
  const f = await fixture(t);
  const prior = await f.issues.read(f.id);
  const other = f.content.replace('Original request.', 'Another writer changed the request.');
  await f.issues.commit({
    issueId: f.id,
    expectedRevision: prior.revision,
    operationId: 'other-writer',
    report: other,
    location: 'open',
  });
  await assert.rejects(
    () => updateStoredIssueMetadata(f.root, f.issue, { title: 'Stale title' }),
    /authoritative issue report changed/
  );
  assert.equal((await f.stores.readIssue(f.id)).report, other);
  assert.equal(readFileSync(join(f.root, '.issues', f.id + '.md'), 'utf8'), f.content);
});

test('registered owner permits in-attempt report writes and archive moves retain canonical report bytes', async (t) => {
  const f = await fixture(t);
  const operation = await f.stores.coordination.operation('work-attempt', 'test', {});
  const owner = f.stores.coordination.owner(operation, f.id);
  await f.stores.coordination.acquire(owner, 'work-claim');
  const unregister = registerProjectStores(f.root, f.stores, { ownerForIssue: () => owner });
  t.after(unregister);
  await updateStoredIssueMetadata(f.root, f.issue, { title: 'Owner update' });
  assert.ok(await f.stores.coordination.owned(owner));
  const saved = await f.stores.readIssue(f.id);
  await moveStoredIssue(f.root, f.id, 'open', 'closed', { expectedContent: saved.report });
  await moveStoredIssue(f.root, f.id, 'closed', 'archive', { expectedContent: saved.report });
  assert.equal((await f.stores.readIssue(f.id)).location, 'archive');
  assert.equal((await f.stores.readIssue(f.id)).report, saved.report);
  assert.ok(existsSync(join(f.root, '.issues/archive', f.id + '.md')));
  assert.equal(existsSync(join(f.root, '.issues', f.id + '.md')), false);
});

test('confirmed report replay survives a lost response and later report edits and location changes', async (t) => {
  const f = await fixture(t);
  const next = f.content.replace('Original request.', 'First confirmed report.');
  const save = f.stores.saveIssue.bind(f.stores);
  let first = true;
  f.stores.saveIssue = async (input) => {
    const result = await save(input);
    if (first) {
      first = false;
      throw Object.assign(Error('Confirmed reply lost'), { code: 'STORE_UNAVAILABLE' });
    }
    return result;
  };
  await assert.rejects(commitStoredReport(f.root, f.issue, next, { operationId: 'stable-publication' }), {
    code: 'STORE_UNAVAILABLE',
  });
  const second = next.replace('First confirmed report.', 'A later report edit.');
  await commitStoredReport(f.root, { ...f.issue, content: next }, second, { operationId: 'later-publication' });
  await moveStoredIssue(f.root, f.id, 'open', 'closed', { expectedContent: second });
  const before = (await f.issues.history(f.id)).length;
  const replay = await commitStoredReport(f.root, f.issue, next, { operationId: 'stable-publication' });
  assert.equal(replay.report, second);
  assert.equal(replay.location, 'closed');
  assert.equal((await f.issues.history(f.id)).length, before);
  await assert.rejects(commitStoredReport(f.root, f.issue, second, { operationId: 'stable-publication' }), {
    code: 'STORE_OPERATION_MISMATCH',
  });
});

test('a location move with a lost committed response resumes its pending claim before reporting success', async (t) => {
  const f = await fixture(t);
  const commit = f.issues.commit.bind(f.issues);
  let first = true;
  f.issues.commit = async (input) => {
    const result = await commit(input);
    if (first) {
      first = false;
      throw Object.assign(Error('Location response lost'), { code: 'STORE_UNAVAILABLE' });
    }
    return result;
  };
  await assert.rejects(moveStoredIssue(f.root, f.id, 'open', 'closed', { expectedContent: f.content }), {
    code: 'STORE_UNAVAILABLE',
  });
  await moveStoredIssue(f.root, f.id, 'open', 'closed', { expectedContent: f.content });
  assert.equal(await f.stores.records.get('claims/' + f.id), null);
});
