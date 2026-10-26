import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { finalizeDelivery, currentDelivery } from './factory-ui/delivery.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { decisionBasis } from './factory-ui/recorded-result.mjs';
import { FactoryUI } from './factory-ui/service.mjs';

// Every format uses the actual decision handler, disk queue and human-input guard.
function workflowFixture(t, format) {
  const f = deliveryFixture(t);
  finalizeDelivery(f.queue.root, f.input);
  const receipt = currentDelivery(readQueue(f.queue.root).issues[0]);
  const report = join(f.queue.root, '.issues', f.input.issueId + '.md');
  const edit = (change) => {
    const text = readFileSync(report, 'utf8'),
      end = text.indexOf('\n---', 4);
    const metadata = YAML.parse(text.slice(4, end));
    change(metadata);
    writeFileSync(report, '---\n' + YAML.stringify(metadata) + '---' + text.slice(end + 4));
  };
  if (format !== 'delivery')
    edit((metadata) => {
      delete metadata.delivery;
      metadata.lifecycle_history =
        format === 'stage-history'
          ? [
              {
                state: 'verify',
                next: 'final',
                outcome: 'completed',
                revision: f.input.revision,
                evidence: receipt.evidence,
              },
            ]
          : [];
    });
  if (format === 'legacy-prose')
    writeFileSync(report, readFileSync(report, 'utf8') + '\nCommitted as `' + f.input.revision + '`.\n');
  const service = new FactoryUI(f.queue.root);
  t.after(() => service.close());
  const issue = () => readQueue(f.queue.root).issues[0];
  const basis = () => decisionBasis(readQueue(f.queue.root), issue());
  return { ...f, service, report, edit, issue, basis, proof: receipt.evidence[0].path };
}
const unrelatedChanges = {
  commit(f) {
    writeFileSync(join(f.queue.root, 'later.js'), 'another feature\n');
    f.queue.git('add', 'later.js');
    f.queue.git('commit', '-qm', 'Unrelated issue');
  },
  branch(f) {
    f.queue.git('checkout', '-qb', 'another-issue');
  },
  dirty(f) {
    writeFileSync(join(f.queue.root, 'code.js'), 'unfinished unrelated source\n');
  },
  'other-issue'(f) {
    writeFileSync(
      join(f.queue.root, '.issues/20261025-two.md'),
      '---\nid: 20261025-two\nstate: verify\n---\nOther issue changed\n'
    );
    f.service.store.add({ id: '20261025-two' }, 'review', f.input.revision);
  },
  'unrelated-coordinator-lock'(f) {
    mkdirSync(join(f.queue.root, '.issues/factory-progress.lock'));
  },
};
for (const format of ['delivery', 'stage-history', 'legacy-prose']) {
  for (const [change, mutate] of Object.entries(unrelatedChanges)) {
    test(`${format}: Close accepts its recorded result after unrelated ${change}`, (t) => {
      const f = workflowFixture(t, format),
        basis = f.basis();
      mutate(f);
      assert.equal(f.issue().state, 'final', 'mutation itself never accepts');
      f.service.decideIssue(f.input.issueId, 'final', 'close', basis);
      const accepted = f.issue().accepted_result;
      assert.equal(f.issue().state, 'closed');
      assert.equal(accepted.revision, f.input.revision);
      assert.equal(accepted.verification_rerun, false);
      assert.equal(accepted.observed_project_revision, f.queue.git('rev-parse', 'HEAD'));
    });
  }
  test(`${format}: changed selected report invalidates the displayed decision`, (t) => {
    const f = workflowFixture(t, format),
      basis = f.basis();
    writeFileSync(f.report, readFileSync(f.report, 'utf8') + '\nNew requirement\n');
    assert.throws(() => f.service.decideIssue(f.input.issueId, 'final', 'close', basis), /issue changed/);
    assert.equal(f.issue().state, 'final');
  });
  for (const status of ['pending', 'failed']) {
    test(`${format}: ${status} human observation remains a blocker`, (t) => {
      const f = workflowFixture(t, format);
      f.edit((m) => {
        m.human_checks = [
          {
            id: 'device',
            kind: 'evidence',
            status,
            blocks: 'closure',
            instructions: 'Observe the real device.',
            revision: f.input.revision,
            result: null,
          },
        ];
      });
      assert.throws(() => f.service.decideIssue(f.input.issueId, 'final', 'close', f.basis()), /actual observation/);
      assert.equal(f.issue().state, 'final');
      assert.equal(f.issue().human_checks[0].status, status);
    });
  }
  test(`${format}: work on this issue still blocks Close`, (t) => {
    const f = workflowFixture(t, format);
    const run = f.service.store.add({ id: f.input.issueId }, 'review', f.input.revision);
    f.service.store.update(run, { issueId: f.input.issueId, status: 'running' });
    assert.throws(() => f.service.decideIssue(f.input.issueId, 'final', 'close', f.basis()), /issue action/);
    assert.equal(f.issue().state, 'final');
  });
}
for (const format of ['delivery', 'stage-history']) {
  for (const change of ['changed', 'missing']) {
    test(`${format}: ${change} retained proof blocks Close with the evidence path`, (t) => {
      const f = workflowFixture(t, format);
      if (change === 'changed') writeFileSync(f.proof, 'tampered proof\n');
      else unlinkSync(f.proof);
      assert.throws(
        () => f.service.decideIssue(f.input.issueId, 'final', 'close', f.basis()),
        (error) => error.message.includes(f.proof)
      );
      assert.equal(f.issue().state, 'final');
      assert.equal(f.issue().accepted_result, undefined);
    });
  }
}
