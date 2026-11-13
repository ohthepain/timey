import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { flowClosureArtifact, publishFlowPR, verifiedFlowCandidate } from './factory-ui/flow-delivery.mjs';
import { decideIssue } from './factory-ui/issue-decision.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { decisionBasis } from './factory-ui/recorded-result.mjs';
import { digest } from './factory-ui/common.mjs';

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
      target: { branch: 'dev', remote: 'origin' },
      request: { goal: 'Make the flow explicit' },
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
      assert.match(publication.body, /Independent verification/);
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
  };
}

test('a new flow closes through the actual decision writer with immutable verification and merged target evidence', async (t) => {
  const f = fixture(t);
  assert.equal(readQueue(f.root).issues[0].state, 'verify');
  await f.close();
  const closed = readQueue(f.root, {
    location: 'closed',
    issueId: f.ctx.issue.id,
  }).issues[0];
  assert.equal(closed.state, 'closed');
  assert.equal(closed.accepted_result.revision, f.input.revision);
  assert.equal(closed.accepted_result.verification_rerun, false);
  assert.ok(closed.accepted_result.evidence.length > 2);
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

for (const changed of ['summary', 'command'])
  test(`changed ${changed} proof blocks flow acceptance`, async (t) => {
    const f = fixture(t);
    const checked = f.ctx.flow.blocks[0].attempts[0].result;
    writeFileSync((changed === 'summary' ? checked.proof : checked.supportingProof)[0].path, 'Changed evidence.\n');
    await assert.rejects(f.close(), /verification evidence changed/);
    assert.equal(readQueue(f.root).issues[0].state, 'verify');
  });

test('publication uses verified exact-head non-force push and the mandatory App publication method', async (t) => {
  const f = fixture(t);
  f.provider.findByBranch = async () => null;
  const result = await publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options);
  assert.deepEqual(f.calls, ['credentials', 'push', 'publish']);
  assert.equal(result.result.pr, 17);
  assert.equal(readQueue(f.root).issues[0].state, 'verify');
});

test('publication refuses stale proof, missing App identity and the target branch before push', async (t) => {
  const f = fixture(t);
  f.provider.findByBranch = async () => null;
  f.provider.credentials = null;
  await assert.rejects(publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options), /GitHub App credentials/);
  f.provider.credentials = { async session() {} };
  await assert.rejects(
    publishFlowPR(f.service, f.ctx, { ...f.workspace, branch: 'dev' }, f.folder, f.options),
    /separate from the target/
  );
  f.ctx.flow.blocks[0].attempts[0].result.head = 'obsolete';
  await assert.rejects(publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options), /explicit Verify block/);
  assert.deepEqual(f.calls, []);
});

test('publication rejects auto-merge and merge-queue enrollment before pushing', async (t) => {
  const f = fixture(t);
  const pr = {
    number: 17,
    state: 'open',
    user: { login: 'factory[bot]' },
    auto_merge: {},
    head: { ref: f.workspace.branch, repo: { full_name: 'test/fixture' } },
    base: { ref: 'dev', repo: { full_name: 'test/fixture' } },
  };
  f.provider.findByBranch = async () => pr;
  await assert.rejects(
    publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options),
    /Remove this PR from auto-merge/
  );
  pr.auto_merge = null;
  f.provider.gh = async () =>
    JSON.stringify({
      data: {
        repository: { pullRequest: { mergeQueueEntry: { id: 'queue' } } },
      },
    });
  await assert.rejects(publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options), /merge queue/);
  assert.ok(!f.calls.includes('push'));
});

test('publication preserves a personally authored PR without pushing its branch', async (t) => {
  const f = fixture(t);
  f.provider.findByBranch = async () => ({
    number: 17,
    user: { login: 'person' },
  });
  await assert.rejects(publishFlowPR(f.service, f.ctx, f.workspace, f.folder, f.options), /Preserve its authorship/);
  assert.ok(!f.calls.includes('push'));
});

test('candidate validation requires both checkpoints and hashes every retained command before delivery', (t) => {
  const f = fixture(t);
  f.ctx.flow.blocks[0].attempts[0].result.proof.pop();
  assert.throws(() => verifiedFlowCandidate(f.ctx, f.workspace), /independent verification and step evidence/);
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
