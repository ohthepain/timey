import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { openIssueStore, openRecordStore } from './factory-ui/stores/providers.mjs';
import { openArtifactStore } from './factory-ui/stores/artifacts.mjs';
import { createProjectStores } from './factory-ui/stores/project-stores.mjs';
import { registerProjectStores } from './factory-ui/stores/report-access.mjs';
import { newFlow, makeBlock } from './factory-ui/flow-store.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';

import { runOwnedOperation } from './factory-ui/stores/owned-operation.mjs';
import { updateIssueBranch } from './factory-ui/flow-update-branch.mjs';
import { execFileSync } from 'node:child_process';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
async function fixture(t, baseline) {
  const { root, git } = gitFixture(t, 'project-stores-flow-');
  writeFileSync(join(root, '.gitignore'), '.issues/\n');
  writeFileSync(join(root, 'source.txt'), 'Source\n');
  git('add', '.');
  git('commit', '-qm', 'Initial source');
  git('branch', 'dev');
  const options = { root, projectId: 'fixture' };
  const artifacts = await openArtifactStore({ id: 'files', kind: 'files' }, options);
  git('remote', 'add', 'origin', root);
  const config = { id: 'files', kind: 'git', branch: 'queue' };
  const records = baseline
    ? baseline.recordStore(await baseline.openGitRecords(config, options), artifacts, { storeId: 'files' })
    : await openRecordStore(config, { ...options, artifacts });
  const issues = await openIssueStore({ id: 'files', kind: 'files' }, { ...options, artifacts });
  const project = createProjectStores({
    ...options,
    records,
    artifacts,
    issueStores: { files: issues },
    runnerId: 'runner-a',
  });
  const id = '20261122-integration';
  const report = `---\nid: ${id}\ntitle: Understand storage\nstate: backlog\ncreated: 2026-11-22T12:00:00Z\n---\n\n## Original request\n\nUnderstand the storage behavior.\n`;
  const issue = { id, title: 'Understand storage', content: report, request_type: 'feature' };
  const flow = newFlow(issue, { remote: 'origin', branch: 'dev', base: null });
  const block = makeBlock('understand', ['request']);
  flow.blocks.push(block);
  flow.executionSettings = { values: { branch: 'dev' }, sources: {}, basis: 'fixture' };
  await project.importIssue({ id, report, flow, storeId: 'files', operationId: 'import-integration' });
  await project.refresh();
  const service = {
    root,
    projectStores: project,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    store: { runs: [], connected: new Set() },
    issueChats: { active: new Map() },
    ownServer() {},
  };
  const flows = createIssueFlows(service, {
    executor: {
      run() {
        throw Error('Unexpected model execution');
      },
      close() {},
    },
    observer: { observe: async () => ({}) },
  });
  service.flows = flows;
  t.after(() => flows.close());
  t.after(registerProjectStores(root, project, { ownerForIssue: (issueId) => flows.active.get(issueId)?.storeOwner }));
  return { root, git, records, issues, project, flows, service, id, blockId: block.id };
}

const baselineRevision = '3549f7e8afbc52bf724448e74a9d2460f1c1962c';
const previousTrace = process.env.GIT_TRACE2_EVENT;
const temporary = mkdtempSync(join(tmpdir(), 'timey-branch-benchmark-'));
const trace = join(temporary, 'git.trace');
process.env.GIT_TRACE2_EVENT = trace;
const measurements = [];
async function baselineModule(path) {
  const source = execFileSync('git', ['show', baselineRevision + ':' + path], { encoding: 'utf8' });
  const rewritten = source.replace(
    /from (['"])(\.[^'"]+)\1/g,
    (_match, quote, specifier) =>
      'from ' + quote + new URL(specifier, new URL('../' + path, import.meta.url)).href + quote
  );
  const file = join(temporary, path.split('/').at(-1));
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
const baseline = process.argv.includes('--compare')
  ? {
      ...(await baselineModule('scripts/factory-ui/stores/providers/git.mjs')),
      ...(await baselineModule('scripts/factory-ui/stores/providers/records.mjs')),
      ...(await baselineModule('scripts/factory-ui/stores/owned-operation.mjs')),
    }
  : null;

const variants = {
  before: { provider: baseline, run: baseline?.runOwnedOperation },
  after: { provider: null, run: runOwnedOperation },
};

async function measure(variant, index) {
  const cleanup = [];
  const f = await fixture({ after: (fn) => cleanup.push(fn) }, variants[variant].provider);
  try {
    const base = f.git('rev-parse', 'HEAD');
    const checkout = join(f.root, '.issues/issue-work', f.id);
    const plain = join(f.root, '.issues/plain');
    f.git('worktree', 'add', '-b', 'issue', checkout, base);
    f.git('worktree', 'add', '-b', 'plain', plain, base);
    const workspace = { checkout, branch: 'issue', base };
    const issue = f.flows.selected(f.id);
    const flow = f.flows.read(issue);
    flow.workspace = workspace;
    await f.flows.store.save(flow, flow.revision);
    writeFileSync(join(f.root, 'incoming.txt'), 'Incoming ' + index + '\n');
    f.git('add', 'incoming.txt');
    f.git('commit', '-qm', 'Advance source');
    const target = f.git('rev-parse', 'HEAD');
    f.git('branch', '-f', 'dev', target);
    const phases = [];
    const timed = async (name, run) => {
      const start = performance.now();
      try {
        return await run();
      } finally {
        phases.push({ name, ms: performance.now() - start });
      }
    };
    const raw = () =>
      timed('plainFetchMerge', () => {
        f.git('-C', plain, 'fetch', '--no-tags', 'origin', '+refs/heads/dev:refs/remotes/origin/dev');
        f.git('-C', plain, 'merge', '--no-edit', '--no-overwrite-ignore', target);
        assert.equal(f.git('-C', plain, 'rev-parse', 'HEAD'), target);
      });
    if (index % 2 === 0) await raw();
    writeFileSync(trace, '');
    const start = performance.now();
    const run = variants[variant].run;
    await run(f.flows, {
      issue,
      flow: f.flows.read(issue),
      label: 'Update issue branch manually',
      operation: 'manual-update',
      run: async (context) =>
        timed('gitUpdate', async () => {
          const result = await updateIssueBranch(
            workspace,
            { remote: 'origin', branch: 'dev' },
            async (command, args) =>
              timed(args[0], () => {
                const output = execFileSync(command, args, { cwd: checkout, encoding: 'utf8', stdio: 'pipe' });
                if (output) context.onProgress(output);
                return output;
              }),
            () => {
              throw Error('Unexpected conflict');
            },
            context.signal
          );
          assert.equal(result.target, target);
          assert.equal(f.git('-C', checkout, 'rev-parse', 'HEAD'), target);
          return { summary: 'Branch updated.', workspace, result };
        }),
    });
    const elapsedMs = performance.now() - start;
    const commands = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .filter((entry) => entry.event === 'start');
    if (index % 2 !== 0) await raw();
    const sample = {
      variant,
      elapsedMs,
      phases,
      remoteReads: commands.filter((entry) => entry.argv.includes('ls-remote')).length,
      pushes: commands.filter((entry) => entry.argv.includes('push')).length,
      gitCommands: commands.length,
    };
    const saved = await f.project.readIssue(f.id);
    assert.equal(saved.flow.retiredBlocks.at(-1).attempts.at(-1).status, 'completed');
    assert.equal(await f.records.get('claims/' + f.id), null);
    assert.equal(f.git('-C', checkout, 'status', '--porcelain'), '');
    return sample;
  } finally {
    for (const fn of cleanup.reverse()) await fn();
  }
}
try {
  for (let index = 0; index < Number(process.env.RUNS || 5); index++) {
    for (const variant of baseline ? ['before', 'after'] : ['after']) {
      const sample = await measure(variant, index);
      measurements.push(sample);
      console.log(JSON.stringify(sample));
    }
  }
  console.log(
    JSON.stringify({ baselineRevision, cores: availableParallelism(), load: loadavg(), errors: 0, measurements })
  );
  if (process.argv.includes('--assert'))
    assert.ok(
      measurements
        .filter(({ variant }) => variant === 'after')
        .every((sample) => sample.remoteReads === 2 && sample.pushes === 2),
      'Update Branch must use two atomic metadata publications'
    );
} finally {
  if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
  else process.env.GIT_TRACE2_EVENT = previousTrace;
  rmSync(temporary, { recursive: true, force: true });
}
