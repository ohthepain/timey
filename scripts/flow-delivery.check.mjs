import { writeBrowserEvidenceFixture } from './flow-browser-evidence-fixture.mjs';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { flowClosureArtifact, prepareFlowPublication, publishFlowPR } from './factory-ui/flow-delivery.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { decideIssue } from './factory-ui/issue-decision.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { decisionBasis } from './factory-ui/recorded-result.mjs';
import { digest } from './factory-ui/common.mjs';
import { StrategyProvider } from './factory-ui/strategy-provider.mjs';
import { gitFixture } from './git-fixture.mjs';

function fixture(t, { sourceChange = true } = {}) {
  const f = deliveryFixture(t, { sourceChange });
  const root = f.queue.root;
  const service = new FactoryUI(root);
  t.after(() => service.close());
  const config = {
    provider: 'github',
    repository: 'test/fixture',
    remote: 'origin',
    target: 'dev',
  };
  writeFileSync(join(root, '.issues/issue-delivery-config.json'), JSON.stringify(config));
  const workspace = {
    checkout: f.source.root,
    base: f.input.base,
    branch: f.source.git('branch', '--show-current'),
  };
  f.source.git('remote', 'add', 'origin', 'git@github.com:test/fixture.git');
  const folder = join(root, '.issues/flow-proof');
  mkdirSync(folder);
  const proof = f.input.verification.map((path) => ({
    path,
    sha256: digest(readFileSync(path)),
  }));
  const supportingProof = f.input.verification
    .flatMap((path) => JSON.parse(readFileSync(path, 'utf8')).checks)
    .flatMap((check) => [check.log, ...(check.artifacts || []).map((file) => file.path)])
    .map((path) => ({ path, sha256: digest(readFileSync(path)) }));
  const ctx = {
    issue: readQueue(root).issues[0],
    attempt: { id: 'flow-delivery' },
    input: { confirmed: true },
    block: { prompt: 'Publish the requested issue.' },
    signal: new AbortController().signal,
    onProgress() {},
    flow: {
      type: 'feature',
      target: { branch: 'dev', remote: 'origin' },
      request: {
        goal: 'Make the flow explicit',
        requestedProof: 'Run the browser flow and show the saved issue.',
        wording: 'Describe the work.\n\n## Original heading',
      },
      blocks: [
        {
          kind: 'verify',
          attempts: [
            {
              status: 'completed',
              result: {
                head: f.input.revision,
                tree: f.source.git('rev-parse', 'HEAD^{tree}'),
                base: workspace.base,
                proof,
                supportingProof,
              },
            },
          ],
        },
      ],
    },
  };
  const calls = [];
  const provider = {
    config,
    credentials: {
      async session() {
        calls.push('credentials');
        return { slug: 'factory' };
      },
    },
    async findByBranch() {
      return { number: 17 };
    },
    async findIssueBranchPR() {
      return null;
    },
    async gh() {
      return `dev\t${f.input.base}\nrelease\t${f.input.base}`;
    },
    async inspectExternalDelivery(number) {
      return {
        number,
        head: f.input.revision,
        branch: workspace.branch,
        target: 'dev',
        targetRevision: 'current-target',
        mergedAt: '2026-11-13T10:00:00Z',
        mergeCommit: 'merge-revision',
      };
    },
    async publish(work, head, publication) {
      calls.push('publish');
      assert.equal(work.branch, workspace.branch);
      assert.equal(head, f.input.revision);
      assert.equal(
        publication.body,
        '## Goal\n\nMake the flow explicit\n\n## Requested proof\n\nRun the browser flow and show the saved issue.\n\n## Original wording\n\nDescribe the work.\n\n## Original heading'
      );
      return { number: 17, html_url: 'https://example.invalid/pr/17' };
    },
  };
  const options = {
    provider,
    async execute(input) {
      calls.push('push');
      assert.deepEqual(input.args, ['push', 'origin', `${f.input.revision}:refs/heads/${workspace.branch}`]);
      writeFileSync(input.log, 'Fixture publication output.\n');
    },
  };
  const close = async () => {
    const artifact = await flowClosureArtifact(service, ctx, workspace, folder, options);
    const queue = readQueue(root),
      issue = queue.issues[0];
    return decideIssue(
      service,
      issue.id,
      issue.state,
      'close',
      decisionBasis(queue, issue),
      '',
      'fixed',
      null,
      artifact
    );
  };
  const edit = (change) => {
    const path = join(root, '.issues', ctx.issue.id + '.md');
    const text = readFileSync(path, 'utf8'),
      end = text.indexOf('\n---', 4);
    const metadata = YAML.parse(text.slice(4, end));
    change(metadata);
    writeFileSync(path, '---\n' + YAML.stringify(metadata) + '---' + text.slice(end + 4));
  };
  return {
    ...f,
    root,
    service,
    workspace,
    folder,
    ctx,
    options,
    provider,
    calls,
    close,
    edit,
    async preview() {
      return (await prepareFlowPublication(service, ctx, workspace, options)).preview;
    },
    async publish() {
      ctx.input.previewToken = (await this.preview()).token;
      return publishFlowPR(service, ctx, workspace, folder, options);
    },
  };
}

test('Publish previews and publishes the exact commit without running full Verify', async (t) => {
  const f = fixture(t);
  const verification = f.ctx.flow.blocks.pop().attempts[0].result;
  const preview = await f.preview();
  assert.equal(preview.head, verification.head);
  assert.equal(f.calls.includes('push'), false);
  f.ctx.input.previewToken = preview.token;
  f.options.verifyCandidate = async () => {
    f.calls.push('verify');
    return { result: verification, evidence: [] };
  };
  const result = await publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options);
  assert.deepEqual(
    f.calls.filter((call) => call !== 'credentials'),
    ['push', 'publish']
  );
  assert.equal(result.result.verification, undefined);
});

test('Publish pushes a Factory Flow change without running local tests', async (t) => {
  const f = fixture(t);
  const path = 'scripts/factory-ui/issue-annotations.mjs';
  mkdirSync(join(f.workspace.checkout, 'scripts/factory-ui'), { recursive: true });
  writeFileSync(join(f.workspace.checkout, path), 'export const issueAnnotation = 1;\n');
  f.source.git('add', path);
  f.source.git('commit', '-m', 'Change issue annotations');
  const head = f.source.git('rev-parse', 'HEAD');
  f.input.revision = head;

  const { execute } = f.options;
  f.options.execute = async (input) => {
    assert.equal(input.command, 'git', 'Publish should only execute the Git push');
    return execute(input);
  };

  const result = await f.publish();
  assert.equal(result.result.head, head);
  assert.deepEqual(
    f.calls.filter((call) => call !== 'credentials'),
    ['push', 'publish']
  );
});

test('Publish ignores failed test evidence and leaves the committed source unchanged', async (t) => {
  const f = fixture(t);
  f.ctx.flow.blocks[0].attempts[0] = {
    status: 'blocked',
    summary: 'Browser test failed.',
  };
  const before = f.source.git('rev-parse', 'HEAD', 'HEAD^{tree}');
  const forbidden = async () => assert.fail('Publish must not test or repair source.');
  Object.assign(f.options, { verifyCandidate: forbidden, verifyWork: forbidden, repair: forbidden });
  const result = await f.publish();
  assert.equal(result.result.pr, 17);
  assert.equal(f.source.git('rev-parse', 'HEAD', 'HEAD^{tree}'), before);
  assert.equal(f.source.git('status', '--porcelain', '--untracked-files=all'), '');
  assert.deepEqual(
    f.calls.filter((call) => call !== 'credentials'),
    ['push', 'publish']
  );
});

test('Publish offers Cannot Reproduce without pushing when the destination already contains the candidate', async (t) => {
  const f = fixture(t);
  f.provider.gh = async () => `dev\t${f.input.revision}`;
  const preview = await f.preview();
  assert.equal(preview.status, 'blocked');
  assert.equal(preview.suggestedResolution, 'cannot-reproduce');
  assert.match(preview.message, /No changes/);
  await assert.rejects(f.publish(), /No changes/);
  assert.ok(!f.calls.includes('push'));
  assert.ok(!f.calls.includes('publish'));
  assert.ok(!readQueue(f.root).issues[0].closed);
});

function publicationDestination(t, f) {
  const destination = gitFixture(t, 'publication-destination-');
  destination.git('fetch', '--no-tags', f.source.root, f.input.base);
  destination.git('checkout', '-qb', 'dev', 'FETCH_HEAD');
  writeFileSync(join(destination.root, 'destination-only.txt'), 'Destination advanced independently.\n');
  destination.git('add', 'destination-only.txt');
  destination.git('commit', '-qm', 'Advance destination');
  const target = destination.git('rev-parse', 'HEAD');
  f.provider.gh = async () => `dev\t${target}`;
  f.source.git('update-ref', 'refs/heads/dev', f.input.base);
  f.source.git('update-ref', 'refs/remotes/origin/dev', f.input.base);
  assert.equal(f.source.git('rev-parse', 'dev'), f.source.git('rev-parse', 'origin/dev'));
  assert.throws(() => f.source.git('cat-file', '-e', target + '^{commit}'));
  const transport = join(f.source.root, '.issues', 'destination-transport.sh');
  writeFileSync(transport, `exec git-upload-pack '${destination.root}'\n`);
  f.source.git('config', 'core.sshCommand', `sh '${transport}'`);
  f.source.git('config', 'ssh.variant', 'ssh');
  return { destination, target };
}

function rejectPublicationFetch(f) {
  const marker = join(f.source.root, '.issues', 'publication-fetch-attempted');
  const transport = join(f.source.root, '.issues', 'failed-destination-transport.sh');
  writeFileSync(transport, `touch '${marker}'\nexit 1\n`);
  f.source.git('config', 'core.sshCommand', `sh '${transport}'`);
  f.source.git('config', 'ssh.variant', 'ssh');
  return marker;
}

function unchangedPublicationCandidate(f, before) {
  assert.equal(f.source.git('rev-parse', 'HEAD', 'HEAD^{tree}'), before);
  assert.equal(f.source.git('status', '--porcelain', '--untracked-files=all'), '');
  assert.ok(!f.calls.includes('push'));
  assert.ok(!f.calls.includes('publish'));
}

test('Publish fetches the observed destination commit before comparing issue changes', async (t) => {
  const f = fixture(t);
  const { target } = publicationDestination(t, f);
  const before = f.source.git('rev-parse', 'HEAD', 'HEAD^{tree}');
  const preview = await f.preview();
  assert.equal(preview.status, 'confirm', preview.message);
  assert.equal(f.source.git('rev-parse', 'refs/remotes/origin/dev'), target);
  unchangedPublicationCandidate(f, before);
});

test('Publish can retry a failed destination fetch without changing the candidate', async (t) => {
  const f = fixture(t);
  const { target } = publicationDestination(t, f);
  const attempted = rejectPublicationFetch(f);
  const before = f.source.git('rev-parse', 'HEAD', 'HEAD^{tree}');
  const preview = await f.preview();
  assert.equal(preview.status, 'blocked');
  assert.match(preview.message, /fetch/i);
  assert.match(preview.message, /retry Publish/i);
  assert.equal(existsSync(attempted), true);
  unchangedPublicationCandidate(f, before);
  f.source.git('config', 'core.sshCommand', `sh '${join(f.source.root, '.issues', 'destination-transport.sh')}'`);
  const retried = await f.preview();
  assert.equal(retried.status, 'confirm', retried.message);
  assert.equal(f.source.git('rev-parse', 'refs/remotes/origin/dev'), target);
  unchangedPublicationCandidate(f, before);
});

test('Publish does not substitute a different destination commit after fetching', async (t) => {
  const f = fixture(t);
  const { destination, target } = publicationDestination(t, f);
  destination.git('checkout', '-q', '--detach', f.input.base);
  destination.git('update-ref', 'refs/heads/dev', f.input.base);
  const before = f.source.git('rev-parse', 'HEAD', 'HEAD^{tree}');
  const preview = await f.preview();
  assert.equal(preview.status, 'blocked');
  assert.match(preview.message, /destination.*changed/i);
  assert.match(preview.message, /retry Publish/i);
  assert.throws(() => f.source.git('cat-file', '-e', target + '^{commit}'));
  assert.equal(f.source.git('rev-parse', 'refs/remotes/origin/dev'), f.input.base);
  unchangedPublicationCandidate(f, before);
});

test('Publish explains unrelated destination history without claiming the branch is stale', async (t) => {
  const f = fixture(t);
  const destination = gitFixture(t, 'publication-unrelated-');
  writeFileSync(join(destination.root, 'unrelated.txt'), 'Independent history.\n');
  destination.git('add', 'unrelated.txt');
  destination.git('commit', '-qm', 'Independent root');
  const target = destination.git('rev-parse', 'HEAD');
  f.source.git('fetch', '--no-tags', destination.root, target);
  f.provider.gh = async () => `dev\t${target}`;
  const attempted = rejectPublicationFetch(f);
  const before = f.source.git('rev-parse', 'HEAD', 'HEAD^{tree}');
  const preview = await f.preview();
  assert.equal(preview.status, 'blocked');
  assert.match(preview.message, /common (ancestor|history)/i);
  assert.doesNotMatch(preview.message, /Refresh the destination branch locally/);
  assert.equal(existsSync(attempted), false);
  unchangedPublicationCandidate(f, before);
});

test('Publish does not fetch a destination commit already available locally', async (t) => {
  const f = fixture(t);
  const attempted = rejectPublicationFetch(f);
  const before = f.source.git('rev-parse', 'HEAD', 'HEAD^{tree}');
  const preview = await f.preview();
  assert.equal(preview.status, 'confirm', preview.message);
  assert.equal(existsSync(attempted), false);
  unchangedPublicationCandidate(f, before);
});

test('Publish detects an empty commit and ignores destination-only changes', async (t) => {
  const f = fixture(t);
  f.source.git('checkout', '-b', 'no-change', f.input.base);
  f.source.git('commit', '--allow-empty', '-qm', 'No source changes');
  f.workspace.branch = 'no-change';
  f.provider.gh = async () => `dev\t${f.input.revision}`;
  const preview = await f.preview();
  assert.equal(preview.status, 'blocked');
  assert.equal(preview.suggestedResolution, 'cannot-reproduce');
});

test('a new flow closes through the actual decision writer with immutable verification and merged target evidence', async (t) => {
  const f = fixture(t);
  const { tree } = f.ctx.flow.blocks[0].attempts[0].result;
  const proofPath = join(f.folder, 'work-proof.json');
  writeFileSync(proofPath, '{"observations":["moved into folder","reordered","moved out"]}');
  const file = { path: proofPath, sha256: digest(readFileSync(proofPath)), label: 'Requested proof evidence' };
  for (const [id, candidateTree, proof] of [
    ['matched', tree, file],
    ['changed', 'older-tree', file],
    ['unavailable', tree, { ...file, sha256: 'incorrect' }],
    ['missing', tree, undefined],
  ]) {
    f.ctx.flow.blocks.push({
      id,
      kind: 'work',
      attempts: [{ id, status: 'completed', result: { tree: candidateTree }, artifacts: { files: { proof } } }],
    });
  }
  assert.equal(readQueue(f.root).issues[0].state, 'verify');
  await f.close();
  const closed = readQueue(f.root, {
    location: 'closed',
    issueId: f.ctx.issue.id,
  }).issues[0];
  assert.equal(closed.state, 'closed');
  assert.equal(closed.accepted_result.revision, f.input.revision);
  assert.equal(closed.accepted_result.verification_rerun, false);
  assert.ok(closed.accepted_result.evidence.some(({ sha256 }) => sha256 === file.sha256));
  const manifest = JSON.parse(readFileSync(join(f.folder, 'merged-delivery.json'), 'utf8'));
  assert.equal(manifest.candidateTree, tree);
  assert.equal(manifest.workProof.requested, f.ctx.flow.request.requestedProof);
  assert.deepEqual(
    manifest.workProof.attempts.map(({ status }) => status),
    ['retained', 'different-tree', 'unavailable', 'missing']
  );
  assert.deepEqual(manifest.workProof.attempts[0], {
    blockId: 'matched',
    attemptId: 'matched',
    tree,
    status: 'retained',
    file,
  });
});

test('Close retains browser proof only for the delivered repair commit and tree', async (t) => {
  const f = fixture(t);
  const { head, tree } = f.ctx.flow.blocks[0].attempts[0].result;
  const browser = join(f.folder, 'repair-browser.json');
  writeFileSync(browser, JSON.stringify({ fixture: 'GitHub responses are simulated.' }));
  const file = { path: browser, sha256: digest(readFileSync(browser)) };
  const repairBrowserProof = { attemptId: 'merge-1', round: 2, sourceCommit: head, sourceTree: tree, file };
  const receipt = join(f.folder, 'receipt.json');
  const result = { pr: 17, head, revision: 'merge-revision' };
  f.ctx.flow.blocks.push({ kind: 'merge', attempts: [{ status: 'completed', result }] });
  for (const [proof, qualifies] of [
    [{ ...repairBrowserProof, sourceCommit: f.workspace.base }, false],
    [{ ...repairBrowserProof, sourceTree: 'earlier-tree' }, false],
    [repairBrowserProof, true],
  ]) {
    writeFileSync(receipt, JSON.stringify({ repairBrowserProof: proof }));
    result.deliveryReceipt = { path: receipt, sha256: digest(readFileSync(receipt)) };
    const closure = await flowClosureArtifact(f.service, f.ctx, f.workspace, f.folder, f.options);
    const manifest = JSON.parse(readFileSync(join(f.folder, 'merged-delivery.json')));
    assert.deepEqual(manifest.repairBrowserProof, qualifies ? proof : undefined);
    assert.equal(
      closure.evidence.some(({ path }) => path === browser),
      qualifies
    );
  }
});

test('Close retains the original Work file and exact candidate browser replay without a rerun', async (t) => {
  const f = fixture(t);
  const { head, tree } = f.ctx.flow.blocks[0].attempts[0].result;
  const retain = (name, value) => {
    const path = join(f.folder, name);
    writeFileSync(path, JSON.stringify(value));
    return { path, sha256: digest(readFileSync(path)) };
  };
  const proof = retain('initial-work.json', { observation: 'Work proof from an earlier tree.' });
  f.ctx.flow.blocks.push({
    id: 'initial-work',
    kind: 'work',
    attempts: [
      { id: 'initial-work', status: 'completed', result: { tree: 'earlier-tree' }, artifacts: { files: { proof } } },
    ],
  });
  const result = { pr: 17, head, revision: 'merge-revision' };
  f.ctx.flow.blocks.push({ kind: 'merge', attempts: [{ status: 'completed', result }] });
  const command = ['node', 'scripts/flow-browser.mjs', '--asset-storage'];
  const log = retain('command.log', { observation: 'Fixture browser exited zero.' });
  for (const [testedTree, retained] of [
    ['wrong-tree', false],
    [tree, true],
  ]) {
    const results = retain('results.json', {
      passed: true,
      candidate: { revision: head, tree: testedTree, clean: true },
    });
    const browser = { candidate: { head, tree }, command, exit: 0, log, results };
    result.deliveryReceipt = retain('receipt.json', { candidate: { commit: head, tree }, browser });
    await flowClosureArtifact(f.service, f.ctx, f.workspace, f.folder, f.options);
    const manifest = JSON.parse(readFileSync(join(f.folder, 'merged-delivery.json')));
    assert.deepEqual(manifest.browser, retained ? browser : undefined);
    assert.equal(manifest.workProof.attempts[0].status, 'different-tree');
    assert.deepEqual(manifest.workProof.attempts[0].file, proof);
  }
  await f.close();
  const [closed] = readQueue(f.root, { location: 'closed', issueId: f.ctx.issue.id }).issues;
  assert.equal(closed.accepted_result.verification_rerun, false);
  assert.ok(closed.accepted_result.evidence.some(({ sha256 }) => sha256 === result.deliveryReceipt.sha256));
});

function githubClosureFixture(f, checks) {
  const provider = new StrategyProvider(f.workspace.checkout, f.provider.config);
  const { head } = f.ctx.flow.blocks[0].attempts[0].result;
  const repo = { full_name: provider.config.repository };
  provider.findByBranch = f.provider.findByBranch;
  provider.inspect = async () => ({
    state: 'closed',
    merged_at: '2026-11-13T10:00:00Z',
    merge_commit_sha: 'merge-revision',
    head: { sha: head, ref: f.workspace.branch, repo },
    base: { ref: 'dev', repo },
  });
  provider.gh = async ([command, resource]) => {
    if (command === 'pr') return JSON.stringify({ files: [{ path: 'src/feature.ts' }], statusCheckRollup: checks });
    if (resource.includes('/compare/')) {
      assert.equal(resource, 'repos/test/fixture/compare/merge-revision...target-sha');
      return JSON.stringify({ status: 'ahead', behind_by: 0 });
    }
    assert.equal(resource, 'graphql');
    const pullRequest = {
      headRefOid: head,
      baseRefName: 'dev',
      baseRefOid: 'base-before-merge',
      baseRef: { target: { oid: 'target-sha' } },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
    };
    return JSON.stringify([{ data: { repository: { pullRequest } } }]);
  };
  f.options.provider = provider;
}

const failedCheck = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' };

test('Close accepts a merged master through Flow without a separate child proof file', async (t) => {
  const f = fixture(t);
  githubClosureFixture(f, [{ ...failedCheck, conclusion: 'SUCCESS', isRequired: true }]);
  f.edit((metadata) => {
    metadata.title = 'Deliver grouped changes';
  });
  f.queue.git('update-ref', 'refs/heads/dev', 'HEAD');
  const flows = (f.service.flows = createIssueFlows(f.service));
  const { issue: child } = await flows.action({
    action: 'capture',
    requestId: randomUUID(),
    description: 'Deliver the attached code change.',
  });
  const id = f.ctx.issue.id;
  f.edit((metadata) => {
    metadata.issue_group = { children: [{ id: child.id, title: child.title }] };
  });
  const queue = readQueue(f.root, { issueId: id });
  const issue = queue.issues[0];
  const flow = flows.read(flows.selected(id));
  const artifact = await flowClosureArtifact(f.service, { ...f.ctx, issue }, f.workspace, f.folder, f.options);

  await flows.closeWithReason(
    {
      issueId: id,
      flowRevision: flow.revision,
      state: issue.state,
      basis: decisionBasis(queue, issue),
      resolution: 'fixed',
    },
    artifact
  );
  await flows.closureTasks.get(id);
  await flows.active.get(id)?.task;

  assert.equal(flows.selected(id).closed, true);
  assert.equal(flows.selected(child.id).closure.fixed_by, id);
  assert.equal(flows.selected(child.id).closure.reason, 'fixed-by');
});

for (const [label, checks] of [
  ['no observed checks', []],
  ['a failed optional check', [{ ...failedCheck, isRequired: false }]],
  ['a pending optional check', [{ ...failedCheck, status: 'IN_PROGRESS', isRequired: false }]],
])
  test(`Close accepts a merged PR with ${label}`, async (t) => {
    const f = fixture(t);
    githubClosureFixture(f, checks);
    await f.close();
    assert.equal(readQueue(f.root, { location: 'closed', issueId: f.ctx.issue.id }).issues[0].state, 'closed');
  });

for (const [check, reason] of [
  [failedCheck, /Failed checks/],
  [{ ...failedCheck, status: 'IN_PROGRESS' }, /PR checks are pending/],
])
  test(`Close blocks on a required ${check.status === 'COMPLETED' ? 'failed' : 'pending'} check`, async (t) => {
    const f = fixture(t);
    githubClosureFixture(f, [{ ...check, isRequired: true }]);
    await assert.rejects(f.close(), reason);
    assert.equal(readQueue(f.root).issues[0].state, 'verify');
  });

for (const status of ['pending', 'failed'])
  test(`flow closure retains the actual ${status} human observation guard`, async (t) => {
    const f = fixture(t);
    f.edit((metadata) => {
      metadata.human_checks = [
        {
          id: 'device',
          kind: 'evidence',
          status,
          blocks: 'closure',
          instructions: 'Observe the physical device.',
          revision: f.input.revision,
          result: null,
        },
      ];
    });
    await assert.rejects(f.close(), /actual observation/);
    assert.equal(readQueue(f.root).issues[0].state, 'verify');
  });

test('flow closure needs explicit acceptance and leaves the report open', async (t) => {
  const f = fixture(t);
  f.ctx.input.confirmed = false;
  await assert.rejects(f.close(), /Accept the recorded result explicitly/);
  assert.equal(readQueue(f.root).issues[0].state, 'verify');
});

test('unmerged or mismatched delivery cannot supply a closure artifact', async (t) => {
  const f = fixture(t);
  f.provider.inspectExternalDelivery = async () => {
    throw Error('The other pull request must be merged');
  };
  await assert.rejects(f.close(), /must be merged/);
  f.provider.inspectExternalDelivery = async () => ({
    number: 17,
    head: 'different-candidate',
  });
  await assert.rejects(f.close(), /does not match the recorded/);
  assert.equal(readQueue(f.root).issues[0].state, 'verify');
});

function retainMergedCandidate(f) {
  const verification = f.ctx.flow.blocks[0].attempts[0].result;
  f.ctx.flow.blocks.push({
    kind: 'merge',
    attempts: [
      {
        status: 'completed',
        invalidatedAt: '2026-11-20T22:36:01Z',
        result: { pr: 17, head: f.input.revision, revision: 'merge-revision', verification },
      },
    ],
  });
  writeFileSync(join(f.source.root, 'after-merge.txt'), 'Later checkout work\n');
  f.source.git('add', 'after-merge.txt');
  f.source.git('commit', '-qm', 'Later unrelated work');
}

test('Close accepts the retained merged candidate after its checkout advances', async (t) => {
  const f = fixture(t);
  retainMergedCandidate(f);
  await f.close();
  assert.equal(readQueue(f.root, { location: 'closed', issueId: f.ctx.issue.id }).issues[0].state, 'closed');
  assert.equal(JSON.parse(readFileSync(join(f.folder, 'merged-delivery.json'), 'utf8')).head, f.input.revision);
  assert.deepEqual(f.calls, []);
});

test('Close uses the merged PR receipt when local verification evidence is unavailable', async (t) => {
  const f = fixture(t);
  retainMergedCandidate(f);
  const checked = f.ctx.flow.blocks[0].attempts[0].result;
  unlinkSync(checked.proof[0].path);
  await f.close();
  assert.equal(readQueue(f.root, { location: 'closed', issueId: f.ctx.issue.id }).issues[0].state, 'closed');
});

test('publication uses a confirmed exact-head non-force push and the mandatory App publication method', async (t) => {
  const f = fixture(t);
  f.ctx.flow.destination = { branch: 'release' };
  const preview = await f.preview();
  assert.equal(preview.target, 'release');
  assert.equal(preview.status, 'confirm');
  assert.ok(!f.calls.includes('push'));
  f.ctx.input.previewToken = preview.token;
  const result = await publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options);
  assert.deepEqual(
    f.calls.filter((call) => call !== 'credentials'),
    ['push', 'publish']
  );
  assert.equal(result.result.pr, 17);
  assert.equal(readQueue(f.root).issues[0].state, 'verify');
});

for (const replacement of ['candidate', 'other-head', 'changed-title', 'stale-head'])
  void test('publication waits only for its own pushed head: ' + replacement, async (t) => {
    const f = fixture(t);
    const pr = {
      number: 17,
      state: 'open',
      draft: false,
      title: f.ctx.issue.title,
      user: { login: 'factory[bot]' },
      head: { ref: f.workspace.branch, repo: { full_name: 'test/fixture' }, sha: 'old-head' },
      base: { ref: 'dev', repo: { full_name: 'test/fixture' } },
    };
    let pushed = false;
    let delayed = false;
    f.provider.findIssueBranchPR = async () => pr;
    f.provider.inspect = async () => {
      if (!pushed || !delayed || replacement === 'stale-head') return pr;
      return {
        ...pr,
        title: replacement === 'changed-title' ? 'Changed independently' : pr.title,
        head: { ...pr.head, sha: replacement === 'other-head' ? 'another-head' : f.input.revision },
      };
    };
    f.provider.gh = async (args) =>
      args.includes('graphql') ? JSON.stringify({ data: { repository: { pullRequest: {} } } }) : 'dev';
    const execute = f.options.execute;
    f.options.execute = async (input) => {
      await execute(input);
      pushed = true;
    };
    f.options.publicationDelay = async () => {
      delayed = true;
    };
    const result = await f.publish();
    if (replacement === 'candidate') assert.equal(result.status, undefined);
    else assert.equal(result.status, 'blocked');
    assert.equal(f.calls.filter((call) => call === 'push').length, 1);
    assert.equal(delayed, true);
  });

test('publication authorized by starting the route creates the PR without a preview confirmation', async (t) => {
  const f = fixture(t);
  f.ctx.input = { automaticPublication: true };
  const result = await publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options);
  assert.equal(result.result.pr, 17);
  assert.deepEqual(
    f.calls.filter((call) => call !== 'credentials'),
    ['push', 'publish']
  );
});

test('Publish links the earlier failed browser assertion and groups both folder checks before push', async (t) => {
  const f = fixture(t);
  const registry = join(f.workspace.checkout, 'scripts', 'browser-scenario-policy.mjs');
  mkdirSync(join(registry, '..'), { recursive: true });
  writeFileSync(
    registry,
    "const flowBrowserScenarioNames = { '--capture-folder-issue': 'Capture', '--folder-workspace-grouping': 'Group' };"
  );
  f.source.git('add', 'scripts');
  f.source.git('commit', '-qm', 'Add focused scenario registry');
  const head = f.source.git('rev-parse', 'HEAD');
  const tree = f.source.git('rev-parse', 'HEAD^{tree}');
  f.ctx.input = { automaticPublication: true };
  f.ctx.block.attempts = [];
  f.ctx.flow.blocks.push({
    kind: 'work',
    attempts: [
      {
        status: 'completed',
        result: { focusedTests: [['node', 'scripts/flow-browser.mjs', '--capture-folder-issue']] },
      },
    ],
  });
  const assertion = 'AssertionError: The .md menu is missing.';
  f.options.execute = async (input) => {
    assert.equal(input.command, 'node', 'No remote write occurs when the browser check fails.');
    assert.deepEqual(input.args, ['scripts/flow-browser.mjs', '--capture-folder-issue', '--folder-workspace-grouping']);
    writeBrowserEvidenceFixture(input, {
      head,
      tree,
      scenarios: [{ name: 'Capture', passed: false, error: assertion }],
    });
  };
  const publish = async (id) => {
    const folder = join(f.folder, id);
    mkdirSync(folder);
    const result = await publishFlowPR(f.service, { ...f.ctx, attempt: { id } }, f.workspace, folder, f.options);
    f.ctx.block.attempts.push({ id, ...result });
    return result;
  };
  const first = await publish('first');
  assert.equal(first.status, 'blocked');
  assert.match(first.summary, new RegExp(head.slice(0, 12)));
  assert.equal(first.result.assertion, assertion);
  const retry = await publish('retry');
  assert.equal(retry.status, 'blocked');
  assert.equal(retry.result.priorAttemptId, 'first');
  assert.match(retry.summary, /same assertion/);
  assert.ok(retry.summary.includes(head.slice(0, 12)));
  assert.ok(retry.summary.includes('Capture. ' + assertion));
  assert.ok(retry.summary.includes(retry.result.repairCommand.join(' ')));
  assert.deepEqual(retry.result.browser.candidate, first.result.browser.candidate);
  assert.equal(f.source.git('status', '--porcelain'), '');
  assert.equal(f.calls.includes('push') || f.calls.includes('publish'), false);
  const prior = retry.evidence.find(({ label }) => label.includes('Earlier attempt'));
  assert.equal(prior.path, first.result.browser.log.path);
  assert.equal(digest(readFileSync(prior.path)), prior.sha256);
});

test('failed publication retains its sanitized GitHub validation response with the proposed head and target', async (t) => {
  const f = fixture(t);
  f.ctx.input = { automaticPublication: true };
  f.provider.publish = async () => {
    throw Object.assign(Error('GitHub validation failed.'), {
      githubStatus: 422,
      githubResponse: { message: 'Validation Failed', errors: [{ message: 'No commits between dev and issue.' }] },
    });
  };
  const result = await publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options);
  assert.equal(result.status, 'blocked');
  const proof = result.evidence.find(({ key }) => key === 'githubResponse');
  const response = JSON.parse(readFileSync(proof.path, 'utf8'));
  assert.equal(response.status, 422);
  assert.equal(response.head, f.input.revision);
  assert.equal(response.target, 'dev');
  assert.match(response.response.errors[0].message, /No commits between/);
});

test('publication refuses a stale preview, missing App identity and the target branch before push', async (t) => {
  const f = fixture(t);
  f.provider.findByBranch = async () => null;
  f.provider.credentials = null;
  await assert.rejects(publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options), /GitHub App credentials/);
  f.provider.credentials = {
    async session() {
      return { slug: 'factory' };
    },
  };
  await assert.rejects(
    publishFlowPR(f.service, f.ctx, { ...f.workspace, branch: 'dev' }, f.folder, f.options),
    /separate from the target/
  );
  f.ctx.input.previewToken = (await f.preview()).token;
  f.ctx.issue.title += ' changed';
  await assert.rejects(publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options), /updated preview/);
  assert.deepEqual(f.calls, []);
});

test('publication rejects auto-merge and merge-queue enrollment before pushing', async (t) => {
  const f = fixture(t);
  const pr = {
    number: 17,
    state: 'open',
    user: { login: 'factory[bot]' },
    auto_merge: {},
    html_url: 'https://example.invalid/pr/17',
    head: { ref: f.workspace.branch, repo: { full_name: 'test/fixture' } },
    base: { ref: 'dev', repo: { full_name: 'test/fixture' } },
  };
  f.provider.findIssueBranchPR = async () => pr;
  await assert.rejects(f.publish(), /Remove this PR from auto-merge/);
  pr.auto_merge = null;
  f.provider.gh = async (args) =>
    args.includes('--paginate')
      ? 'dev'
      : JSON.stringify({
          data: {
            repository: { pullRequest: { mergeQueueEntry: { id: 'queue' } } },
          },
        });
  await assert.rejects(publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options), /merge queue/);
  assert.ok(!f.calls.includes('push'));
});

test('publication preserves a personally authored PR without pushing its branch', async (t) => {
  const f = fixture(t);
  f.provider.findIssueBranchPR = async () => ({
    number: 17,
    html_url: 'https://example.invalid/pr/17',
    user: { login: 'person' },
    head: { ref: f.workspace.branch, repo: { full_name: 'test/fixture' } },
    base: { ref: 'dev', repo: { full_name: 'test/fixture' } },
  });
  const preview = await f.preview();
  assert.equal(preview.pr.url, 'https://example.invalid/pr/17');
  assert.match(preview.message, /opened manually on GitHub/);
  await assert.rejects(f.publish(), /opened manually on GitHub/);
  assert.ok(!f.calls.includes('push'));
});

test('repeat publication retries only the outstanding title, preserves the GitHub description, and can be up to date', async (t) => {
  const f = fixture(t);
  const pr = {
    number: 17,
    html_url: 'https://example.invalid/pr/17',
    state: 'open',
    title: 'Old title',
    body: 'Hand-edited on GitHub',
    user: { login: 'factory[bot]' },
    head: { ref: f.workspace.branch, repo: { full_name: 'test/fixture' }, sha: 'old-commit' },
    base: { ref: 'dev', repo: { full_name: 'test/fixture' } },
  };
  f.provider.findIssueBranchPR = async () => pr;
  f.provider.inspect = async () => pr;
  let titleFails = true;
  f.provider.gh = async (args) => {
    if (args.includes('--paginate')) return 'dev';
    if (args.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: {} } } });
    assert.ok(args.includes('PATCH'));
    assert.deepEqual(args.slice(-2), ['-f', 'title=' + f.ctx.issue.title]);
    if (titleFails) throw Error('GitHub title update failed.');
    pr.title = f.ctx.issue.title;
    return JSON.stringify(pr);
  };
  const push = f.options.execute;
  f.options.execute = async (input) => {
    await push(input);
    pr.head.sha = f.input.revision;
  };
  const first = await f.preview();
  assert.equal(first.push, true);
  assert.equal(first.rename, true);
  assert.equal(first.body, undefined);
  const staleToken = first.token;
  f.ctx.issue.title = 'Updated issue title';
  f.ctx.input.previewToken = staleToken;
  await assert.rejects(publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options), /updated preview/);
  assert.ok(!f.calls.includes('push'));
  const failed = await f.publish();
  assert.equal(failed.status, 'blocked');
  assert.match(failed.summary, /Needs retry.*Pushed the issue commit/);
  assert.equal(failed.result.url, pr.html_url);
  titleFails = false;
  const pending = await f.preview();
  assert.equal(pending.push, false);
  assert.equal(pending.rename, true);
  await f.publish();
  assert.equal(f.calls.filter((call) => call === 'push').length, 1);
  assert.equal(pr.body, 'Hand-edited on GitHub');
  assert.equal((await f.preview()).status, 'current');
});

test('Publish still requires a committed checkout', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source.root, 'candidate-proof.txt'), 'uncommitted content\n');
  await assert.rejects(
    prepareFlowPublication(f.service, f.ctx, f.workspace, f.options),
    /Commit the verified working-tree snapshot before publishing/
  );
});

function investigationFixture(t, kind = 'understand') {
  const f = fixture(t, { sourceChange: false });
  unlinkSync(join(f.root, '.issues/issue-delivery-config.json'));
  const output = 'The subsystem reads saved blocks and starts only the requested block.\n';
  const path = join(f.folder, 'output.txt');
  writeFileSync(path, output);
  f.ctx.flow.type = 'investigation';
  f.ctx.flow.workspace = { ...f.workspace };
  f.ctx.flow.target.base = f.workspace.base;
  f.ctx.flow.blocks = [
    {
      kind,
      attempts: [
        {
          status: 'completed',
          output,
          evidence: [{ path, sha256: digest(readFileSync(path)) }],
          result: {
            head: f.input.revision,
            base: f.workspace.base,
            tree: f.source.git('rev-parse', 'HEAD^{tree}'),
          },
        },
      ],
    },
    { kind: 'close', attempts: [{ id: f.ctx.attempt.id, status: 'running' }] },
  ];
  f.provider.findByBranch = async () => {
    throw Error('An investigation must not query PR delivery.');
  };
  return { ...f, understanding: f.ctx.flow.blocks[0].attempts[0] };
}

for (const kind of ['understand', 'investigate'])
  test(`read-only ${kind} acceptance uses the canonical writer with retained output and no PR claims`, async (t) => {
    const f = investigationFixture(t, kind);
    await f.close();
    const issue = readQueue(f.root, {
      location: 'closed',
      issueId: f.ctx.issue.id,
    }).issues[0];
    assert.equal(issue.state, 'closed');
    assert.equal(issue.accepted_result.revision, f.workspace.base);
    assert.equal(issue.accepted_result.verification_rerun, false);
    assert.equal(issue.accepted_result.evidence.length, 1);
    assert.equal(readFileSync(issue.accepted_result.evidence[0].path, 'utf8'), f.understanding.output);
    assert.deepEqual(f.calls, []);
  });

for (const change of ['dirty', 'committed', 'branch', 'saved-base'])
  test(`investigation closure rejects ${change} source context`, async (t) => {
    const f = investigationFixture(t);
    if (change === 'dirty' || change === 'committed') {
      writeFileSync(join(f.source.root, 'code.js'), 'export const value = 2;\n');
      if (change === 'committed') {
        f.source.git('add', 'code.js');
        f.source.git('commit', '-qm', 'Changed source');
      }
    } else if (change === 'branch') f.source.git('checkout', '-qb', 'other-investigation');
    else f.ctx.flow.target.base = 'changed-base';
    await assert.rejects(f.close(), /clean saved checkout at the original base/);
    assert.equal(readQueue(f.root).issues[0].state, 'verify');
  });

for (const change of ['missing', 'changed', 'no-digest', 'no-result', 'empty-output', 'stale-head', 'incomplete'])
  test(`investigation closure rejects ${change} understanding proof`, async (t) => {
    const f = investigationFixture(t);
    if (change === 'missing') f.understanding.evidence[0].path += '.missing';
    else if (change === 'changed') writeFileSync(f.understanding.evidence[0].path, 'Changed output.\n');
    else if (change === 'no-digest') delete f.understanding.evidence[0].sha256;
    else if (change === 'no-result') delete f.understanding.result;
    else if (change === 'empty-output') f.understanding.output = '';
    else if (change === 'stale-head') f.understanding.result.head = 'other-head';
    else f.understanding.status = 'blocked';
    await assert.rejects(f.close(), /investigation|immutable digest|Understand/);
    assert.equal(readQueue(f.root).issues[0].state, 'verify');
  });

for (const status of ['running', 'stopping', 'uncertain'])
  test(`investigation closure rejects a ${status} block`, async (t) => {
    const f = investigationFixture(t);
    f.ctx.flow.blocks.push({
      kind: 'advice',
      attempts: [{ id: 'another-block', status }],
    });
    await assert.rejects(f.close(), /active or uncertain blocks/);
  });

for (const status of ['pending', 'failed'])
  test(`investigation closure preserves ${status} actual human observation requirements`, async (t) => {
    const f = investigationFixture(t);
    f.edit((metadata) => {
      metadata.human_checks = [
        {
          id: 'device',
          kind: 'evidence',
          status,
          blocks: 'closure',
          instructions: 'Observe the physical device.',
          revision: f.workspace.base,
          result: null,
        },
      ];
    });
    await assert.rejects(f.close(), /actual observation/);
    assert.equal(readQueue(f.root).issues[0].state, 'verify');
  });

test('investigation closure still requires explicit acceptance', async (t) => {
  const f = investigationFixture(t);
  f.ctx.input.confirmed = false;
  await assert.rejects(f.close(), /Accept the recorded result explicitly/);
});

test('closure uses the selected flow type when derived Request fields were invalidated', async (t) => {
  const f = fixture(t);
  f.ctx.flow.routeType = 'bug';
  f.ctx.flow.blocks.unshift({
    id: 'request',
    kind: 'request',
    data: { wording: 'Fix the bug', fields: null },
    attempts: [],
  });
  f.ctx.details = { type: undefined };
  const result = await flowClosureArtifact(f.service, f.ctx, f.workspace, f.folder, f.options);
  assert.equal(result.revision, f.input.revision);
});
