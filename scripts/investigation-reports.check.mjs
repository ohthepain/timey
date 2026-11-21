import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { factoryGitFixture } from './git-fixture.mjs';
import { digest } from './factory-ui/common.mjs';
import { InvestigationReports } from './factory-ui/investigation-reports.mjs';
import { InvestigationOutputs } from './factory-ui/investigation-outputs.mjs';
import { listAvailableSkills, skillInputs } from './factory-ui/skills.mjs';
import { defaultIssueFolder } from './factory-ui/issue-folder-settings.mjs';

const source = () => ({
  issueId: 'investigation-fixture',
  blockId: 'inquiry',
  attemptId: 'original-inquiry',
  startedAt: '2026-11-21T10:00:00.000Z',
  revision: 'a'.repeat(40),
  findings: 'The parser loses the final event.',
  evidence: [],
});

function reportFixture(t) {
  const { root } = factoryGitFixture(t, 'investigation-reports-');
  const report = join(root, 'report.md');
  const evidence = join(root, 'evidence.txt');
  writeFileSync(report, '# Findings\n\n## Executive summary\nThe parser drops the final event.\n');
  writeFileSync(evidence, 'expected 3, observed 2');
  const reports = new InvestigationReports(root);
  const input = {
    publicationId: randomUUID(),
    source: source(),
    attemptId: 'report-attempt',
    workspace: root,
    title: 'Parser investigation',
    report,
    evidence: [{ path: evidence, sha256: digest(readFileSync(evidence)) }],
    additionalFindings: 'A newer revision still fails.',
    inspectedRevisions: ['a'.repeat(40), 'b'.repeat(40)],
  };
  return { root, report, evidence, reports, input };
}

test('publications recover once per attempt and deliberate generations remain separate immutable reports', (t) => {
  const { root, report, evidence, reports, input } = reportFixture(t);
  assert.deepEqual(reports.list(), []);
  const first = reports.publish(input);
  const original = first.content;
  assert.equal(first.source.attemptId, 'original-inquiry');
  assert.equal(first.attemptId, 'report-attempt');
  assert.deepEqual(first.inspectedRevisions, ['a'.repeat(40), 'b'.repeat(40)]);
  assert.equal(first.evidence[0].status, 'verified');
  writeFileSync(report, '# A changed original');
  assert.equal(reports.publish({ ...input, attemptId: 'retry-attempt' }).id, first.id);
  const deliberate = reports.publish({ ...input, publicationId: randomUUID(), attemptId: 'new-generation' });
  assert.notEqual(deliberate.id, first.id);
  assert.equal(reports.list().length, 2);
  rmSync(report);
  rmSync(evidence);
  assert.equal(new InvestigationReports(root).read(first.id).content, original);
  assert.equal(reports.publish(input).id, first.id);
  assert.equal(reports.read(first.id).evidence[0].status, 'verified');
  assert.throws(
    () => reports.publish({ ...input, source: { ...source(), attemptId: 'different-inquiry' } }),
    /another inquiry/
  );
});

test('missing, changed, or unretained evidence never hides the retained report', (t) => {
  const { reports, input, report, root } = reportFixture(t);
  const saved = reports.publish({
    ...input,
    evidence: [...input.evidence, { path: join(root, 'missing.txt') }, { path: report, sha256: '0'.repeat(64) }],
  });
  assert.deepEqual(
    saved.evidence.map(({ status }) => status),
    ['verified', 'unavailable', 'unverified']
  );
  writeFileSync(saved.evidence[0].path, 'tampered');
  assert.equal(reports.read(saved.id).evidence[0].status, 'unverified');
  rmSync(saved.evidence[0].path);
  const unavailable = reports.read(saved.id);
  assert.equal(unavailable.evidence[0].status, 'unavailable');
  assert.match(unavailable.content, /parser drops/);
  assert.equal(unavailable.contentVerified, true);
});

test('report evidence supplements source evidence and preserves source digests when duplicate paths are supplied', (t) => {
  const { reports, input, evidence, report } = reportFixture(t);
  const original = { path: evidence, sha256: '0'.repeat(64), name: 'Original inquiry evidence' };
  const inquiry = { ...source(), evidence: [original] };
  const supplemented = reports.publish({ ...input, source: inquiry, evidence: [report, './evidence.txt'] });
  assert.equal(supplemented.evidence.length, 2);
  const retainedOriginal = supplemented.evidence.find(({ original: path }) => path === evidence);
  assert.equal(retainedOriginal.status, 'unverified');
  assert.equal(retainedOriginal.name, 'Original inquiry evidence');
  assert.equal(supplemented.evidence.find(({ original: path }) => path === report).status, 'verified');
  const noNewEvidence = reports.publish({ ...input, publicationId: randomUUID(), source: inquiry, evidence: [] });
  assert.equal(noNewEvidence.evidence.length, 1);
  assert.equal(noNewEvidence.evidence[0].status, 'unverified');
});

test('publication refuses report references escaping their checkout', (t) => {
  const { root, reports, input } = reportFixture(t);
  const outside = join(root, '..', 'outside-' + randomUUID());
  writeFileSync(outside, 'private');
  t.after(() => rmSync(outside, { force: true }));
  const link = join(root, 'escape.md');
  symlinkSync(outside, link);
  assert.throws(() => reports.publish({ ...input, report: link }), /belong to/);
  assert.throws(() => reports.read('../other'), /identity/);
  assert.deepEqual(reports.list(), []);
});

const finding = (key, title) => ({
  key,
  title,
  type: 'bug',
  description: 'Save all events.',
  reason: 'The final event is currently lost.',
  verification: 'Assert all three events survive.',
});

function outputFixture(t) {
  const { root } = factoryGitFixture(t, 'investigation-issues-');
  const issues = [{ id: 'existing', title: 'Fix existing parser', state: 'backlog' }];
  const captures = new Map();
  const calls = [];
  let fail = true;
  const flows = {
    service: { root },
    issues: () => structuredClone(issues),
    capture: async (input) => {
      calls.push(input);
      if (input.description.startsWith('Repair the writer') && fail) {
        fail = false;
        throw Error('temporary capture failure');
      }
      const created = captures.get(input.requestId) || { id: 'created-' + captures.size };
      captures.set(input.requestId, created);
      return { issue: created };
    },
  };
  return { root, flows, issues, captures, calls };
}

test('partial issue creation preserves successes across retries and replacement skills without changing matched issues', async (t) => {
  const { flows, issues, captures, calls } = outputFixture(t);
  const original = structuredClone(issues);
  const items = [
    finding('existing-parser', 'Fix existing parser!'),
    finding('parser', 'Repair the parser'),
    finding('writer', 'Repair the writer'),
  ];
  const initial = await new InvestigationOutputs(flows).createIssues({ source: source(), items });
  assert.equal(initial.items[0].result.issueId, 'existing');
  assert.equal(initial.items[0].result.relation, 'linked');
  assert.equal(initial.items[1].result.relation, 'created');
  assert.match(initial.items[2].error, /temporary/);
  assert.equal(captures.size, 1);
  const retry = await new InvestigationOutputs(flows).createIssues({ source: source(), items });
  assert.equal(captures.size, 2);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].requestId, calls[2].requestId);
  assert.equal(retry.items[1].result.issueId, initial.items[1].result.issueId);
  assert.ok(retry.items.every(({ result, error }) => result && !error));
  assert.ok(
    calls.every(
      ({ needsApproval, sourceIssue, sourceAttempt }) =>
        needsApproval && sourceIssue === source().issueId && sourceAttempt === source().attemptId
    )
  );
  assert.deepEqual(issues, original);
  const replaced = new InvestigationOutputs(flows).tools({ kind: 'create-issues', source: source() });
  const receipts = await replaced.invoke('investigation_outputs', {});
  assert.equal(receipts.issues.length, 3);
  assert.deepEqual(
    receipts.issues.map(({ requestId }) => requestId),
    retry.items.map(({ requestId }) => requestId)
  );
  assert.throws(() => replaced.invoke('report_publish', {}), /registered/);
});

test('an uncertain capture is recovered using its original stable request identity', async (t) => {
  const { flows, captures, calls } = outputFixture(t);
  const capture = flows.capture;
  let interrupted = true;
  flows.capture = async (input) => {
    const saved = await capture(input);
    if (interrupted) {
      interrupted = false;
      throw Error('connection ended after save');
    }
    return saved;
  };
  const outputs = new InvestigationOutputs(flows);
  const input = { source: source(), items: [finding('parser', 'Repair the parser')] };
  const partial = await outputs.createIssues(input);
  assert.match(partial.items[0].error, /connection ended/);
  assert.equal(captures.size, 1);
  const recovered = await new InvestigationOutputs(flows).createIssues(input);
  assert.equal(captures.size, 1);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(recovered.items[0].result.issueId, 'created-0');
});

test('replacement skills can register guarded saved references and recover legacy creation receipts', (t) => {
  const { flows, issues } = outputFixture(t);
  issues.push({
    id: 'skill-created',
    title: 'Restore complete events',
    state: 'needs-approval',
    source_issue: source().issueId,
    source_attempt: source().attemptId,
  });
  issues.push({ id: 'unguarded', title: 'Not approved output', state: 'backlog' });
  const outputs = new InvestigationOutputs(flows);
  const historical = {
    ...source(),
    legacyFollowups: [{ id: 'legacy-finding', title: 'Historical creation', issueId: 'legacy-issue' }],
  };
  const saved = outputs.registerIssues({
    source: historical,
    items: [
      { key: 'new-finding', issueId: 'skill-created', relation: 'created' },
      { key: 'existing-finding', issueId: 'existing', relation: 'linked' },
    ],
  });
  assert.equal(saved.items[0].result.issueId, 'legacy-issue');
  assert.equal(saved.items[0].requestId, 'legacy-finding');
  assert.equal(saved.items[1].result.issueId, 'skill-created');
  assert.equal(saved.items[2].result.relation, 'linked');
  assert.throws(
    () =>
      outputs.registerIssues({
        source: source(),
        items: [{ key: 'unguarded', issueId: 'unguarded', relation: 'created' }],
      }),
    /need approval/
  );
  assert.throws(
    () =>
      outputs.registerIssues({
        source: source(),
        items: [{ key: 'new-finding', issueId: 'existing', relation: 'linked' }],
      }),
    /different saved outcome/
  );
});

test('replacement skills recover the full original legacy draft beneath a minimal unfinished session receipt', async (t) => {
  const { root, flows, calls } = outputFixture(t);
  const key = 'old-stable-finding';
  const completedKey = 'old-completed-finding';
  const folder = defaultIssueFolder(root).name;
  const original = {
    ...finding(key, 'Repair original parser'),
    description: 'The reviewed original request.',
    reason: 'The reviewed original reason.',
    verification: 'The reviewed original proof.',
  };
  const inquiry = {
    ...source(),
    legacyFollowups: [
      { id: key, title: 'Suggested parser work', error: 'The original save was interrupted.' },
      { id: completedKey, title: 'Already saved work', issueId: 'old-successful-issue' },
    ],
  };
  const outputs = new InvestigationOutputs(flows);
  outputs.registerIssues({ source: inquiry, items: [] });
  const directory = join(root, '.issues/flows/investigation-followups');
  mkdirSync(directory, { recursive: true });
  const retainedPath = join(root, 'retained-findings.txt');
  const oldSource = {
    issueId: inquiry.issueId,
    attemptId: inquiry.attemptId,
    evidence: { path: retainedPath, sha256: 'f'.repeat(64) },
  };
  writeFileSync(
    join(directory, 'legacy.json'),
    JSON.stringify({
      source: oldSource,
      folder,
      proposals: [
        { ...finding(key, 'Suggested parser work'), id: key, draft: original, error: 'Old partial failure' },
        { ...finding(completedKey, 'Already saved work'), id: completedKey, error: 'Stale failed receipt' },
      ],
    })
  );
  const replacement = new InvestigationOutputs(flows);
  const receipts = await replacement
    .tools({ kind: 'create-issues', source: inquiry })
    .invoke('investigation_outputs', {});
  const retained = receipts.issues.find((item) => item.key === key);
  assert.equal(retained.title, original.title);
  assert.equal(retained.description, original.description);
  assert.equal(retained.reason, original.reason);
  assert.equal(retained.verification, original.verification);
  assert.equal(retained.folder, folder);
  assert.equal(retained.requestId, key);
  assert.equal(receipts.issues.find((item) => item.key === completedKey).result.issueId, 'old-successful-issue');
  assert.equal(receipts.issues.find((item) => item.key === completedKey).error, undefined);
  const attemptedReplacement = finding(key, original.title);
  attemptedReplacement.description = 'A replacement skill must not change previously submitted wording.';
  const recovered = await replacement.createIssues({ source: inquiry, items: [attemptedReplacement], folder });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requestId, key);
  assert.equal(calls[0].folder, folder);
  assert.equal(
    calls[0].description,
    [
      original.title,
      original.description,
      '## Why',
      original.reason,
      '## Requested proof',
      original.verification,
      '## Source investigation',
      inquiry.issueId,
      'Understand attempt: ' + inquiry.attemptId,
      'Retained findings: ' + retainedPath,
      'SHA-256: ' + 'f'.repeat(64),
    ].join('\n\n')
  );
  assert.equal(recovered.items.find((item) => item.key === key).result.issueId, 'created-0');
});

test('default output skills use Factory discovery and carry their guarded saving instructions', async (t) => {
  const { root } = reportFixture(t);
  const skills = await listAvailableSkills({ ready: async () => {}, call: async () => ({ data: [] }) }, root);
  for (const [name, tool] of [
    ['generate-report', 'report_publish'],
    ['create-issues', 'investigation_issues_save'],
  ]) {
    const skill = skills.find((entry) => entry.name === name);
    assert.equal(skill.source, 'Factory');
    assert.match(skillInputs([skill])[0].text, new RegExp(tool));
  }
});

test('saved-output discovery returns report references without automatically passing historical report findings', async (t) => {
  const f = reportFixture(t);
  const report = f.reports.publish(f.input);
  const outputs = new InvestigationOutputs({ service: { root: f.root }, issues: () => [] });
  const saved = await outputs.tools({ kind: 'create-issues', source: source() }).invoke('investigation_outputs', {});
  assert.equal(saved.reports[0].id, report.id);
  assert.equal(saved.reports[0].publicationId, report.publicationId);
  assert.equal(Object.hasOwn(saved.reports[0], 'additionalFindings'), false);
  assert.equal(Object.hasOwn(saved.reports[0], 'content'), false);
  assert.equal(Object.hasOwn(saved.reports[0], 'evidence'), false);
});
