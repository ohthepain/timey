import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import {
  flowClosureArtifact,
  prepareFlowPublication,
  publishFlowPR,
  verifiedFlowCandidate,
} from './factory-ui/flow-delivery.mjs';
import { decideIssue } from './factory-ui/issue-decision.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { decisionBasis } from './factory-ui/recorded-result.mjs';
import { digest } from './factory-ui/common.mjs';
import { StrategyProvider } from './factory-ui/strategy-provider.mjs';

function fixture(t) {
  const f = deliveryFixture(t);
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
      return 'dev\nrelease';
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
  await assert.rejects(f.close(), /does not match the verified/);
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

test('Close still rejects changed original proof after the merged checkout advances', async (t) => {
  const f = fixture(t);
  retainMergedCandidate(f);
  const checked = f.ctx.flow.blocks[0].attempts[0].result;
  writeFileSync(checked.proof[0].path, 'Changed original evidence\n');
  await assert.rejects(f.close(), /verification evidence changed/);
  assert.equal(readQueue(f.root).issues[0].state, 'verify');
});

for (const changed of ['summary', 'command'])
  test(`changed ${changed} proof blocks flow acceptance`, async (t) => {
    const f = fixture(t);
    const checked = f.ctx.flow.blocks[0].attempts[0].result;
    writeFileSync((changed === 'summary' ? checked.proof : checked.supportingProof)[0].path, 'Changed evidence.\n');
    await assert.rejects(f.close(), /verification evidence changed/);
    assert.equal(readQueue(f.root).issues[0].state, 'verify');
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

test('publication authorized by Play creates the PR without a preview confirmation', async (t) => {
  const f = fixture(t);
  f.ctx.input = { automaticPublication: true };
  const result = await publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options);
  assert.equal(result.result.pr, 17);
  assert.deepEqual(
    f.calls.filter((call) => call !== 'credentials'),
    ['push', 'publish']
  );
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

test('candidate validation requires both checkpoints and hashes every retained command before delivery', (t) => {
  const f = fixture(t);
  f.ctx.flow.blocks[0].attempts[0].result.proof.pop();
  assert.throws(() => verifiedFlowCandidate(f.ctx, f.workspace), /independent verification and step evidence/);
});

test('an uncommitted verification survives its unchanged commit and expires when the tree changes', async (t) => {
  const f = fixture(t);
  const source = join(f.source.root, 'candidate-proof.txt');
  writeFileSync(source, 'verified content\n');
  f.source.git('add', 'candidate-proof.txt');
  const tree = f.source.git('write-tree');
  const paths = ['verification', 'step'].map((checkpoint) => {
    const path = join(f.folder, `${checkpoint}.json`);
    writeFileSync(path, JSON.stringify({ checkpoint, checks: [] }));
    return { path, sha256: digest(readFileSync(path)) };
  });
  const verification = {
    head: f.source.git('rev-parse', 'HEAD'),
    tree,
    base: f.workspace.base,
    uncommitted: true,
    proof: paths,
    supportingProof: [],
  };
  f.ctx.flow.blocks[0].attempts[0].result = verification;
  f.options.validateSummary = () => {};
  await assert.rejects(
    prepareFlowPublication(f.service, f.ctx, f.workspace, f.options),
    /Commit the verified working-tree snapshot before publishing/
  );

  f.source.git('commit', '-m', 'Commit verified content');
  assert.equal(verifiedFlowCandidate(f.ctx, f.workspace, { validateSummary: () => {} }).tree, tree);

  writeFileSync(source, 'changed content\n');
  f.source.git('add', 'candidate-proof.txt');
  f.source.git('commit', '-m', 'Change candidate content');
  assert.throws(
    () => verifiedFlowCandidate(f.ctx, f.workspace, { validateSummary: () => {} }),
    /Required independent verification and step evidence is missing/
  );
});

function investigationFixture(t) {
  const f = fixture(t);
  unlinkSync(join(f.root, '.issues/issue-delivery-config.json'));
  const output = 'The subsystem reads saved blocks and starts only the requested block.\n';
  const path = join(f.folder, 'output.txt');
  writeFileSync(path, output);
  f.ctx.flow.type = 'investigation';
  f.ctx.flow.workspace = { ...f.workspace };
  f.ctx.flow.target.base = f.workspace.base;
  f.ctx.flow.blocks = [
    {
      kind: 'understand',
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

test('read-only investigation acceptance uses the canonical writer with retained output and no PR claims', async (t) => {
  const f = investigationFixture(t);
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
