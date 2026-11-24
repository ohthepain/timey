import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { retainGitHubClosureVerification } from './factory-ui/github-closure-proof.mjs';
import { flowClosureArtifact, verifiedFlowCandidate } from './factory-ui/flow-delivery.mjs';

function fixture(t) {
  const f = deliveryFixture(t);
  const workspace = { checkout: f.source.root, base: f.input.base, branch: f.source.git('branch', '--show-current') };
  const directory = join(workspace.checkout, '.issues/evidence/github-closure-42');
  mkdirSync(directory, { recursive: true });
  const step = join(workspace.checkout, '.issues/evidence/local-step-summary.json');
  copyFileSync(f.input.verification[1], step);
  const report = JSON.parse(readFileSync(f.input.verification[0]));
  const remote = '/home/runner/work/fixture/fixture/.issues/evidence';
  const relocate = (path) => {
    copyFileSync(path, join(directory, basename(path)));
    return remote + '/' + basename(path);
  };
  for (const check of report.checks) {
    check.log = relocate(check.log);
    for (const file of check.artifacts || []) file.path = relocate(file.path);
  }
  const summary = join(directory, 'github-summary.json');
  writeFileSync(summary, JSON.stringify(report));
  const bundle = new Map(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))]));
  const run = {
    head_sha: f.input.revision,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/test/fixture/actions/runs/42',
  };
  const delivered = {
    number: 17,
    head: f.input.revision,
    branch: workspace.branch,
    target: 'dev',
    targetRevision: 'target',
    mergedAt: '2026-11-24T00:00:00Z',
    mergeCommit: 'merged',
    checks: [{ detailsUrl: run.html_url + '/job/8' }],
  };
  const provider = {
    config: { repository: 'test/fixture', remote: 'origin', target: 'dev' },
    async gh(args) {
      if (args[0] === 'api') return JSON.stringify(run);
      assert.deepEqual(args.slice(0, 2), ['run', 'download']);
      for (const [name, bytes] of bundle) writeFileSync(join(directory, name), bytes);
      writeFileSync(summary, JSON.stringify(report));
      return '';
    },
    async inspectExternalDelivery() {
      return delivered;
    },
  };
  const pr = {
    number: delivered.number,
    merged_at: delivered.mergedAt,
    merge_commit_sha: delivered.mergeCommit,
    head: { sha: delivered.head, ref: workspace.branch },
    base: { sha: workspace.base, ref: delivered.target },
  };
  provider.inspect = async () => pr;
  const folder = join(f.queue.root, '.issues/closure-proof');
  const retain = () => retainGitHubClosureVerification({ provider, delivered, workspace, folder });
  return { ...f, workspace, directory, step, report, summary, bundle, run, delivered, provider, folder, retain, pr };
}

void test('Close preserves the original workspace base while verifying the merged PR comparison base', async (t) => {
  const f = fixture(t);
  f.source.git('commit', '--allow-empty', '-qm', 'Advance the comparison base');
  const comparisonBase = f.source.git('rev-parse', 'HEAD');
  assert.notEqual(comparisonBase, f.workspace.base);
  f.source.git('commit', '--allow-empty', '-qm', 'Advance issue after updating the target');
  const head = f.source.git('rev-parse', 'HEAD');
  f.run.head_sha = head;
  f.delivered.head = head;
  f.pr.head.sha = head;
  f.pr.base.sha = comparisonBase;
  f.report.base = comparisonBase;
  writeFileSync(f.summary, JSON.stringify(f.report));
  const step = JSON.parse(readFileSync(f.step));
  step.base = comparisonBase;
  writeFileSync(f.step, JSON.stringify(step));
  const verification = await f.retain();
  const checked = verifiedFlowCandidate(
    { flow: { blocks: [] }, block: {}, attempt: {}, evidenceRoot: f.queue.root },
    f.workspace,
    { verification }
  );
  assert.equal(checked.head, head);
  assert.equal(verification.destinationBase, comparisonBase);
  assert.equal(f.workspace.base, f.input.base);
});

void test('Close reuses actual GitHub verification and a matching step audit without rerunning suites', async (t) => {
  const f = fixture(t);
  const result = await f.retain();
  assert.equal(result.proof.length, 2);
  assert.equal(result.origin.head, f.input.revision);
  assert.equal(result.tree, f.source.git('rev-parse', 'HEAD^{tree}'));
  assert.ok(result.supportingProof.length > 2);
  const config = { provider: 'github', ...f.provider.config };
  writeFileSync(join(f.queue.root, '.issues/issue-delivery-config.json'), JSON.stringify(config));
  const flow = {
    type: 'feature',
    target: { remote: 'origin', branch: 'dev' },
    request: { fields: { type: 'feature' } },
    merged: { pr: 17, head: f.input.revision, revision: 'merged' },
    blocks: [],
  };
  const artifact = await flowClosureArtifact(
    { root: f.queue.root },
    {
      flow,
      block: {},
      issue: { id: f.input.issueId },
      input: { confirmed: true },
      signal: new AbortController().signal,
    },
    f.workspace,
    f.folder,
    { provider: f.provider }
  );
  assert.equal(artifact.revision, f.input.revision);
  assert.ok(artifact.evidence.length >= result.proof.length);
});

for (const [name, change, expected] of [
  [
    'a changed merged PR',
    (f) => {
      f.pr.head.sha = '0'.repeat(40);
    },
    /merged PR changed/,
  ],
  [
    'an unavailable comparison base',
    (f) => {
      f.pr.base.sha = 'unavailable';
    },
    /comparison base is unavailable/,
  ],
  [
    'another candidate',
    (f) => {
      f.run.head_sha = '0'.repeat(40);
    },
    /exact candidate/,
  ],
  [
    'a failed workflow',
    (f) => {
      f.run.conclusion = 'failure';
    },
    /exact candidate/,
  ],
  [
    'another source tree',
    (f) => {
      f.report.snapshot_tree = '0'.repeat(40);
      writeFileSync(f.summary, JSON.stringify(f.report));
    },
    /exact candidate tree/,
  ],
  ['missing step evidence', (f) => unlinkSync(f.step), /step audit/],
  [
    'a failed required check',
    (f) => {
      f.report.checks.find((check) => check.name === 'factory').passed = false;
      writeFileSync(f.summary, JSON.stringify(f.report));
    },
    /required check is missing or failed/,
  ],
  [
    'a changed artifact',
    (f) => {
      f.bundle.set('browser.log', Buffer.from('Changed after verification.'));
      writeFileSync(join(f.directory, 'browser.log'), f.bundle.get('browser.log'));
    },
    /changed after verification/,
  ],
  [
    'an artifact outside the download root',
    (f) => {
      f.report.checks[1].artifacts[0].path = '/outside/proof';
      writeFileSync(f.summary, JSON.stringify(f.report));
    },
    /escapes its artifact root/,
  ],
])
  void test('Close rejects ' + name, async (t) => {
    const f = fixture(t);
    change(f);
    await assert.rejects(f.retain(), expected);
  });
