import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { writeProgress } from './factory-progress.mjs';
import { digest, writeJson, readJson } from './factory-ui/common.mjs';
import { proof } from './issue-delivery-store.mjs';
import { IssueDelivery } from './issue-delivery.mjs';
import { FixtureDeliveryProvider, fixtureDeliveryCheck } from './issue-delivery-fixture.mjs';
export async function deliveryScenario(t, merge = 'automatic', actionId = 'one', mode = 'verified-delivery') {
  const { queue } = deliveryFixture(t),
    root = queue.root;
  rmSync(join(root, '.issues/issue-deliveries'), { recursive: true, force: true });
  const issueId = '20261025-one',
    base = queue.git('rev-parse', 'HEAD');
  queue.git('remote', 'add', 'origin', 'https://github.com/fixture/timey.git');
  writeJson(join(root, '.issues/issue-delivery-config.json'), {
    provider: 'github',
    repository: 'fixture/timey',
    remote: 'origin',
    target: 'main',
  });
  const approval = join(root, '.issues/plan-approval.json');
  writeJson(approval, { actor: 'human' });
  const content = '1. Complete the selected issue.\n2. Verify delivery.';
  writeJson(approval, { actor: 'human', issueId, type: 'plan-approval', plan: { sha256: digest(content) } });
  writeProgress(root, {
    issueId,
    plan: { content, sha256: digest(content) },
    approval: { sha256: digest(content), receipt: approval },
  });
  if (mode === 'verified-delivery') {
    const directory = join(root, '.issues/factory-ui');
    writeJson(join(directory, 'runs.json'), {
      version: 1,
      runs: [
        {
          id: 'explicit-delivery-route',
          kind: 'route-choice',
          status: 'completed',
          events: [],
          savedRoutes: [
            {
              issueId,
              steps: [
                {
                  state: '@integration',
                  decision: 'take',
                  reason: 'Exercise the explicitly selected verified delivery workflow.',
                  source: { kind: 'user' },
                },
              ],
            },
          ],
        },
      ],
    });
  }
  const provider = new FixtureDeliveryProvider(root, join(root, '.issues/provider.json'), base);
  const delivery = new IssueDelivery(root, { provider, check: fixtureDeliveryCheck, guard: () => [] });
  const action = addAction(queue, issueId, base, actionId, merge);
  const review = proof(approval);
  await delivery.operate('assemble', { issueId, actionId: action.id, expectedCandidate: base, review });
  return { queue, root, issueId, base, provider, delivery, review, content };
}
export function addAction(queue, issueId, base, id, merge = 'automatic') {
  const branch = queue.git('branch', '--show-current');
  queue.git('checkout', '-qb', 'worker-' + id, base);
  writeFileSync(join(queue.root, id + '.js'), 'export const value = ' + JSON.stringify(id) + ';\n');
  queue.git('add', '.');
  queue.git('commit', '-qm', 'worker ' + id);
  const worker_revision = queue.git('rev-parse', 'HEAD');
  queue.git('checkout', '-q', branch);
  const action = {
    id,
    issues: [issueId],
    basis: { head: base },
    kind: 'implement',
    merge,
    status: 'completed',
    worker_revision,
    dependencies: [],
    evidence: 'Fixture independently reviewed candidate.',
  };
  const path = join(queue.root, '.issues/factory.json'),
    ledger = readJson(path);
  ledger.actions.push(action);
  writeJson(path, ledger);
  return action;
}
export async function ready(f) {
  const d = f.delivery.inspect(f.issueId);
  const checked = await fixtureDeliveryCheck(d.checkout, f.base, join(f.root, '.issues/complete-' + d.generation));
  const manifest = {
    plan: digest(f.content),
    candidate: d.candidate,
    actions: d.contributions.map((c) => c.actionId),
    verification: checked.summaries,
    review: f.review,
    criteria: f.content.split('\n').map((description) => ({ description, evidence: [f.review] })),
  };
  manifest.additionalVerification = {};
  for (const base of new Set(d.contributions.map((c) => c.originalBase))) {
    if (base === f.base) continue;
    const extra = await fixtureDeliveryCheck(d.checkout, base, join(f.root, '.issues/extra-' + base));
    manifest.additionalVerification[base] = extra.summaries;
  }
  await f.delivery.operate('ready', { issueId: f.issueId, manifest });
  return manifest;
}
