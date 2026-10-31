import { DeliveryStore } from './issue-delivery-store.mjs';
import { mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { factory } from './factory-ledger.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { digest } from './factory-ui/common.mjs';

export function deliveryFixture(t) {
  const queue = gitFixture(t, 'delivery-queue-'),
    source = gitFixture(t, 'delivery-source-');
  for (const repo of [queue, source]) {
    writeFileSync(join(repo.root, '.gitignore'), '.issues/\n');
    writeFileSync(join(repo.root, 'code.js'), 'export const value = 1;\n');
    repo.git('add', '.');
    repo.git('commit', '-qm', 'source');
    mkdirSync(join(repo.root, '.issues'));
  }
  const helper = join(queue.root, '.agents/skills/issues/scripts');
  mkdirSync(helper, { recursive: true });
  for (const name of ['human-input.mjs', 'human-input-version.json'])
    cpSync(resolve('.agents/skills/issues/scripts', name), join(helper, name));
  queue.git('add', '.agents');
  queue.git('commit', '-qm', 'guard');
  writeFileSync(
    join(queue.root, '.issues/triage-labels.md'),
    '| Role | State | Next |\n| ready-to-verify | verify | commit |\n| ready-for-commit | commit | final |\n| ready-to-close | final | closed |\n| closed | closed | — |\n'
  );
  writeFileSync(
    join(queue.root, '.issues/20261025-one.md'),
    '---\nid: 20261025-one\nstate: verify\n---\nActual issue\n'
  );
  writeFileSync(join(queue.root, '.issues/preferences.json'), JSON.stringify({ commit: true }));
  factory(queue.root).init();
  const revision = source.git('rev-parse', 'HEAD'),
    tree = source.git('rev-parse', 'HEAD^{tree}');
  const log = join(source.root, '.issues/audit.log');
  writeFileSync(
    log,
    JSON.stringify({
      kind: 'audit',
      schema_version: 13,
      version: '3.35.0',
      verdict: 'pass',
      attribution: { gate: 'all' },
      summary: { dead_code_issues: 0, complexity_findings: 0, duplication_clone_groups: 0 },
      dead_code: { workspace_diagnostics: [] },
    }) + '\n'
  );
  const factoryLog = join(source.root, '.issues/factory.log');
  writeFileSync(factoryLog, 'ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ skipped 0\nPASS browser scenario: fixture\n');
  const browserLog = join(source.root, '.issues', 'browser.log');
  writeFileSync(browserLog, 'PASS browser scenario: fixture\n');
  const verification = ['verification', 'step'].map((checkpoint) => {
    const path = join(source.root, '.issues/' + checkpoint + '.json');
    const names = checkpoint === 'step' ? ['fallow'] : ['fallow', 'browser', 'factory', 'typecheck', 'tests', 'build'];
    writeFileSync(
      path,
      JSON.stringify({
        checkpoint,
        base: revision,
        snapshot_tree: tree,
        passed: true,
        changed_files: [],
        checks: names.map((name) => ({
          name,
          passed: true,
          exit: 0,
          log: name === 'browser' ? browserLog : name === 'factory' ? factoryLog : log,
          ...(name === 'browser'
            ? { artifacts: [{ path: browserLog, sha256: digest(readFileSync(browserLog)) }] }
            : {}),
        })),
      })
    );
    return path;
  });
  const issue = readQueue(queue.root).issues[0];
  const input = {
    operationId: 'delivery-one',
    issueId: issue.id,
    expectedState: issue.state,
    reportDigest: digest(issue.content),
    checkout: source.root,
    revision,
    base: revision,
    verification,
    requirements: [
      { description: 'Reviewed delivered behavior', evidence: [{ path: log, sha256: digest(readFileSync(log)) }] },
    ],
    authorization: { path: log, sha256: digest(readFileSync(log)) },
  };
  // Historical delivery compatibility tests start with retained verified PR proof.
  const store = new DeliveryStore(queue.root, input.issueId);
  store.save({ state: 'preparing-fixture' });
  const pr = { id: 'fixture-pr', url: 'https://github.com/fixture/timey/pull/1' };
  const merge = { revision, tree };
  const integration = store.retain('fixture-integration', { pr, merge, evidence: [] });
  store.save({ state: 'verified', pr, merge, integration });
  return { queue, source, input };
}
