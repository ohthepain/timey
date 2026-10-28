import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, readJson, writeJson, digest } from './factory-ui/common.mjs';

// Deterministic protocol evidence only. These summaries do not prove app checks.
export async function fixtureDeliveryCheck(root, base, folder) {
  mkdirSync(folder, { recursive: true });
  const head = git(root, 'rev-parse', 'HEAD'),
    tree = git(root, 'rev-parse', 'HEAD^{tree}');
  const log = join(folder, 'audit.log');
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
  const factoryLog = join(folder, 'factory.log');
  writeFileSync(factoryLog, 'ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ skipped 0\nPASS browser scenario: fixture\n');
  const browserLog = join(folder, 'browser.log');
  writeFileSync(browserLog, 'PASS browser scenario: fixture\n');
  const summaries = ['verification', 'step', 'commit'].map((checkpoint) => {
    const path = join(folder, checkpoint + '.json');
    const names =
      checkpoint === 'verification' ? ['fallow', 'browser', 'factory', 'typecheck', 'tests', 'build'] : ['fallow'];
    writeJson(path, {
      checkpoint,
      base,
      snapshot_tree: tree,
      changed_files: [],
      passed: true,
      checks: names.map((name) => ({
        name,
        passed: true,
        exit: 0,
        log: name === 'browser' ? browserLog : name === 'factory' ? factoryLog : log,
        ...(name === 'browser' ? { artifacts: [{ path: browserLog, sha256: digest(readFileSync(browserLog)) }] } : {}),
      })),
    });
    return path;
  });
  return { head, tree, summaries };
}
export class FixtureDeliveryProvider {
  constructor(root, path, target) {
    this.root = root;
    this.path = path;
    if (!existsSync(path)) writeJson(path, { target, source: null, prs: [], merges: [], creates: 0, mergeCalls: 0 });
    this.crash = null;
    this.override = {};
  }
  state() {
    return readJson(this.path);
  }
  update(values) {
    writeJson(this.path, { ...this.state(), ...values });
  }
  effect(kind) {
    if (this.crash === kind) {
      this.crash = null;
      throw Error('Interrupted after ' + kind);
    }
  }
  findBranch(request) {
    const value = this.state().source;
    if (value && value !== request.candidate) throw Error('Remote source changed.');
    return value ? [{ revision: value }] : [];
  }
  publish(request) {
    this.update({ source: request.candidate });
    this.effect('publish');
    return { revision: request.candidate };
  }
  findPullRequests() {
    return this.state().prs;
  }
  open(request) {
    const pr = {
      id: 'fixture-pr-1',
      number: 1,
      url: 'https://github.com/fixture/timey/pull/1',
      repository: request.repository,
      source: request.source,
      target: request.target,
      state: 'open',
    };
    this.update({ prs: [pr], creates: this.state().creates + 1 });
    this.effect('open');
    return pr;
  }
  observe(request, pr) {
    return {
      pr,
      candidate: this.state().source,
      target: this.state().target,
      mergeable: true,
      reviewsResolved: true,
      policy: { trusted: true, source: 'deterministic fixture policy', required: ['ci'] },
      checks: [
        {
          name: 'ci',
          state: 'success',
          candidate: request.candidate,
          target: request.targetRevision,
          tree: git(this.root, 'rev-parse', request.candidate + '^{tree}'),
        },
      ],
      capability: { expectedHeadAndTarget: true },
      ...this.override,
    };
  }
  findMerge() {
    return this.state().merges;
  }
  merge(request, pr) {
    const state = this.state();
    if (state.source !== request.candidate || state.target !== request.targetRevision)
      throw Error('Conditional merge rejected a remote race.');
    const merge = {
      revision: request.candidate,
      tree: git(this.root, 'rev-parse', request.candidate + '^{tree}'),
      prId: pr.id,
    };
    this.update({ merges: [merge], target: merge.revision, mergeCalls: state.mergeCalls + 1 });
    this.effect('merge');
    return merge;
  }
  fetchMerge(request, merge, root) {
    git(root, 'cat-file', '-e', merge.revision);
  }
}
