import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';
import { createFlowExecutor } from './factory-ui/flow-executor.mjs';
import { createFlowObserver } from './factory-ui/flow-observer.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { StrategyProvider } from './factory-ui/strategy-provider.mjs';
import { withBrowserScenarioFixture } from './flow-browser-scenario-fixture.mjs';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';

const config = { provider: 'github', repository: 'test/fixture', remote: 'merge-proof', target: 'merge-proof-target' };
const targetRef = 'refs/heads/' + config.target;
const repo = { full_name: config.repository };
const issueLine = 'Issue retains its feature.\n';
const targetLine = 'Target retains its change.\n';
const context = { __typename: 'StatusContext', context: 'Verify', state: 'SUCCESS', isRequired: true };

function commitFile(checkout, path, value) {
  writeFileSync(join(checkout, path), value);
  git(checkout, 'add', path);
  git(checkout, 'commit', '-qm', value.trim());
  return git(checkout, 'rev-parse', 'HEAD');
}

function remoteHead(remote, ref) {
  return git(remote, 'rev-parse', ref);
}

function prMetadata(remote, pr) {
  return {
    number: pr.number,
    html_url: 'https://github.com/' + config.repository + '/pull/' + pr.number,
    state: pr.merge ? 'closed' : 'open',
    draft: false,
    head: { ref: pr.branch, sha: remoteHead(remote, 'refs/heads/' + pr.branch), repo },
    base: { ref: config.target, sha: remoteHead(remote, targetRef), repo },
    merged_at: pr.merge ? new Date().toISOString() : null,
    merge_commit_sha: pr.merge,
  };
}

function readyObservation(remote, pr) {
  const { head, base } = prMetadata(remote, pr);
  assert.notEqual(head.sha, pr.initialHead, 'Readiness was requested for the issue head before publication.');
  assert.equal(git(remote, 'merge-base', head.sha, base.sha), base.sha, 'Readiness was requested before target sync.');
  const tree = git(remote, 'rev-parse', head.sha + '^{tree}');
  pr.events.push({ action: 'GitHub readiness verified', head: head.sha, target: base.sha, tree });
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: head.sha,
          baseRefName: config.target,
          baseRefOid: base.sha,
          baseRef: { target: { oid: base.sha } },
          mergeStateStatus: 'CLEAN',
          mergeable: 'MERGEABLE',
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [context] } } } }] },
        },
      },
    },
  };
}

function advanceTarget(remote, writer, path, contents, events) {
  const target = commitFile(writer, path, contents);
  git(writer, 'push', remote, 'HEAD:' + targetRef);
  events.push({ action: 'Target advanced', target });
  return target;
}

function protectedMerge(remote, writer, pr, args) {
  const head = args.find((arg) => arg.startsWith('sha='))?.slice(4);
  const { head: published } = prMetadata(remote, pr);
  assert.equal(head, published.sha);
  assert.ok(pr.events.some((event) => event.action === 'GitHub readiness verified' && event.head === head));
  if (pr.advanceAtMerge) {
    pr.advanceAtMerge = false;
    advanceTarget(remote, writer, 'late-target.txt', 'Target advanced after verification.\n', pr.events);
  }
  const target = remoteHead(remote, targetRef);
  if (git(remote, 'merge-base', target, head) !== target) {
    pr.events.push({ action: 'GitHub rejected stale merge request', head, target });
    throw Object.assign(Error('Protected target requires the PR to be up to date (HTTP 405).'), { githubStatus: 405 });
  }
  assert.ok(
    pr.events.some(
      (event) => event.action === 'GitHub readiness verified' && event.head === head && event.target === target
    )
  );
  const tree = git(remote, 'rev-parse', head + '^{tree}');
  pr.merge = git(remote, 'commit-tree', tree, '-p', target, '-p', head, '-m', 'Merge fixture PR #' + pr.number);
  git(remote, 'update-ref', targetRef, pr.merge, target);
  pr.events.push({ action: 'GitHub merged', head, target, tree, merge: pr.merge });
  return { merged: true, sha: pr.merge };
}

function observeTestMerge(remote, pr) {
  const metadata = prMetadata(remote, pr);
  if (pr.merge || pr.events.at(-1)?.action === 'GitHub rejected stale merge request') return metadata;
  const { head, base } = metadata;
  assert.notEqual(head.sha, pr.initialHead, 'GitHub test merge was triggered before publication.');
  assert.equal(
    git(remote, 'merge-base', head.sha, base.sha),
    base.sha,
    'GitHub test merge preceded local target sync.'
  );
  pr.events.push({ action: 'GitHub test merge requested', head: head.sha, target: base.sha });
  return metadata;
}

function githubGraphQL(remote, prs, args) {
  if (!args.some((arg) => arg.includes('mergeStateStatus'))) return { data: { repository: { pullRequest: {} } } };
  const number = Number(args.find((arg) => arg.startsWith('number=')).slice(7));
  return [readyObservation(remote, prs.get(number))];
}

function listPRs(remote, prs, query) {
  const branch = new URLSearchParams(query).get('head').split(':').at(-1);
  const pr = [...prs.values()].find((item) => item.branch === branch);
  return pr ? [prMetadata(remote, pr)] : [];
}

function gitHubCommit(remote, commit) {
  const [tree, ...parents] = git(remote, 'show', '-s', '--format=%T %P', commit).split(' ');
  return { sha: commit, tree: { sha: tree }, parents: parents.map((sha) => ({ sha })) };
}

function githubFixture(project, remote, writer, prs) {
  const provider = new StrategyProvider(project, config);
  const ruleset = { id: 42, enforcement: 'active', current_user_can_bypass: 'never' };
  const strictChecks = {
    type: 'required_status_checks',
    ruleset_id: ruleset.id,
    parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: context.context }] },
  };
  const responses = [
    [/^$/, () => ({ allow_merge_commit: true })],
    [/^\/rules\/branches\//, () => [[strictChecks]]],
    [/^\/rulesets\/42$/, () => ruleset],
    [/^graphql$/, (args) => githubGraphQL(remote, prs, args)],
    [/^\/pulls\?(.*)$/, (_, query) => listPRs(remote, prs, query)],
    [/^\/pulls\/(\d+)$/, (_, number) => observeTestMerge(remote, prs.get(Number(number)))],
    [/^\/pulls\/(\d+)\/merge$/, (args, number) => protectedMerge(remote, writer, prs.get(Number(number)), args)],
    [/^\/git\/commits\/(.*)$/, (_, commit) => gitHubCommit(remote, commit)],
  ];
  provider.credentials = null;
  provider.gh = async (args) => {
    const resource = args[1].replace('repos/' + config.repository, '');
    if (resource.startsWith('/branches?')) return config.target + '\t' + remoteHead(remote, targetRef);
    for (const [pattern, respond] of responses) {
      const match = pattern.exec(resource);
      if (match) return JSON.stringify(respond(args, ...match.slice(1)));
    }
    throw Error('Unexpected GitHub fixture resource ' + resource);
  };
  return provider;
}

function prepareRemote(project, output) {
  const remote = join(output, 'merge-remote.git');
  const writer = join(output, 'merge-target-writer');
  mkdirSync(remote);
  git(remote, 'init', '--bare', '-q');
  git(remote, 'config', 'user.name', 'GitHub fixture');
  git(remote, 'config', 'user.email', 'github@example.invalid');
  git(project, 'push', remote, 'HEAD:' + targetRef);
  git(project, 'worktree', 'add', '--detach', writer);
  git(project, 'remote', 'add', config.remote, 'https://github.com/' + config.repository + '.git');
  return { remote, writer };
}

async function savePRFlow(flows, project, remote, pr, base, title) {
  const id = '20261126-merge-proof-' + pr.number;
  await writeBrowserIssue(project, { id, title, body: title + '.' });
  const flow = flows.read(flows.selected(id));
  flow.workspace = { branch: pr.branch, checkout: pr.checkout, base };
  flow.destination = { branch: config.target, pr: pr.number, url: prMetadata(remote, pr).html_url };
  flow.autoClose = false;
  const merge = flow.blocks.find(({ kind }) => kind === 'merge');
  for (const block of flow.blocks.slice(0, flow.blocks.indexOf(merge))) {
    block.attempts = [{ id: 'fixture-' + block.id, status: 'completed', startedAt: new Date().toISOString() }];
  }
  await flows.store.save(flow, flow.revision);
  return { id, pr, merge };
}

async function preparePR(flows, project, remote, writer, scenario) {
  const { number, title, issueFile, targetFile, advanceAtMerge } = scenario;
  const branch = 'codex/merge-proof-' + number;
  const checkout = join(project, '.issues/issue-work', '20261126-merge-proof-' + number);
  const base = remoteHead(remote, targetRef);
  git(writer, 'fetch', remote, targetRef);
  git(writer, 'checkout', '--detach', 'FETCH_HEAD');
  git(project, 'worktree', 'add', '-b', branch, checkout, base);
  const initialHead = commitFile(checkout, issueFile, issueLine);
  git(checkout, 'push', remote, 'HEAD:refs/heads/' + branch);
  const pr = { number, branch, checkout, initialHead, events: [], advanceAtMerge };
  pr.initialTarget = advanceTarget(remote, writer, targetFile, targetLine, pr.events);
  return savePRFlow(flows, project, remote, pr, base, title);
}

function mergeExecutor(service, provider, remote, currentPR) {
  let waits = 0;
  return createFlowExecutor(service, {
    provider,
    async execute({ command, cwd, args, log }) {
      assert.equal(command, 'git');
      appendFileSync(log, '$ git ' + args.join(' ') + '\n');
      if (args[0] === 'fetch') return git(cwd, ...args.map((arg) => (arg === config.remote ? remote : arg)));
      if (args[0] !== 'push') return git(cwd, ...args);
      const result = git(cwd, 'push', remote, ...args.slice(2));
      const [head] = args[2].split(':');
      currentPR().events.push({ action: 'Issue head pushed', head });
      return result;
    },
    async repair(error) {
      const pr = currentPR();
      assert.equal(error.code, 'target-conflict');
      assert.equal(git(pr.checkout, 'rev-parse', 'MERGE_HEAD'), pr.initialTarget);
      assert.equal(git(pr.checkout, 'diff', '--name-only', '--diff-filter=U'), 'source.txt');
      const head = commitFile(pr.checkout, 'source.txt', issueLine + targetLine);
      pr.events.push({ action: 'Owning issue repair committed', head, target: pr.initialTarget });
      return { status: 'completed', summary: 'Preserved both edits in the local merge.', evidence: [] };
    },
    async mergeDelay() {
      assert.ok(++waits < 9, 'The fixture never waits for more than eight GitHub observations.');
    },
  });
}

async function runMergeControl({ page, service, id, merge, pr, poll, screenshot, selectBlock, clickAction }) {
  const current = () => service.flows.read(service.flows.selected(id)).blocks.find(({ id }) => id === merge.id);
  await page.goto('/?issue=' + id);
  await selectBlock(merge.id);
  await clickAction(page.locator('#run-block'));
  const completed = await poll(
    () => current().attempts.at(-1),
    (attempt) => attempt?.endedAt && !service.flows.active.has(id),
    'Merge control did not finish.'
  );
  assert.equal(completed.status, 'completed', completed.summary);
  assert.equal(completed.result.revision, pr.merge);
  const landed = pr.events.at(-1);
  assert.equal(landed.action, 'GitHub merged');
  assert.equal(completed.result.head, landed.head);
  const firstReadiness = pr.events.findIndex((event) => event.action === 'GitHub readiness verified');
  const firstPush = pr.events.findIndex((event) => event.action === 'Issue head pushed');
  assert.ok(firstPush > 0 && firstPush < firstReadiness);
  await page.reload();
  await selectBlock(merge.id);
  await screenshot('merge-target-update-' + pr.number);
  return completed.result;
}

function assertConflictDelivery(remote, pr, result) {
  const repair = pr.events.find((event) => event.action === 'Owning issue repair committed');
  assert.equal(repair?.head, result.head);
  assert.deepEqual(git(remote, 'show', '-s', '--format=%P', repair.head).split(' '), [
    pr.initialHead,
    pr.initialTarget,
  ]);
}

function assertRefreshedDelivery(_remote, pr, result) {
  const stale = pr.events.find((event) => event.action === 'GitHub rejected stale merge request');
  assert.ok(stale);
  assert.notEqual(result.head, stale.head);
  assert.equal(result.target, stale.target);
}

const proofScenarios = [
  {
    number: 71,
    title: 'Update the target before merge',
    issueFile: 'issue.txt',
    targetFile: 'target.txt',
    advanceAtMerge: true,
    contents: {
      'issue.txt': issueLine.trim(),
      'target.txt': targetLine.trim(),
      'late-target.txt': 'Target advanced after verification.',
    },
    assertDelivery: assertRefreshedDelivery,
  },
  {
    number: 72,
    title: 'Repair the target conflict before merge',
    issueFile: 'source.txt',
    targetFile: 'source.txt',
    advanceAtMerge: false,
    contents: { 'source.txt': issueLine.trim() + '\n' + targetLine.trim() },
    assertDelivery: assertConflictDelivery,
  },
];

function observeDelivery(remote, { number, title, contents, assertDelivery }, pr, result) {
  for (const [file, text] of Object.entries(contents))
    assert.equal(git(remote, 'show', result.revision + ':' + file), text);
  assertDelivery(remote, pr, result);
  return {
    number,
    title,
    initialHead: pr.initialHead,
    initialTarget: pr.initialTarget,
    contents,
    events: pr.events,
    result,
  };
}

export async function mergeTargetUpdateBrowserChecks(harness) {
  const { project, service, root, output } = harness;
  const configPath = join(project, '.issues/issue-delivery-config.json');
  const previous = readFileSync(configPath);
  const guard = service.guard;
  const observer = service.flows.observer;
  try {
    await withBrowserScenarioFixture({ project, service }, async () => {
      initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
      const { remote, writer } = prepareRemote(project, output);
      const prs = new Map();
      const provider = githubFixture(project, remote, writer, prs);
      writeFileSync(configPath, JSON.stringify(config));
      service.guard = () => [];
      service.flows.deliveryOptions.provider = provider;
      service.flows.observer = createFlowObserver(service, { provider });
      let activePR;
      service.flows.executor = mergeExecutor(service, provider, remote, () => activePR);
      const scenarios = [];
      for (const scenario of proofScenarios) {
        const { id, pr, merge } = await preparePR(service.flows, project, remote, writer, scenario);
        activePR = pr;
        prs.set(pr.number, pr);
        const result = await runMergeControl({ ...harness, id, merge, pr });
        scenarios.push(observeDelivery(remote, scenario, pr, result));
      }
      writeFileSync(
        join(output, 'merge-target-update.json'),
        JSON.stringify(
          {
            sourceCommit: git(root, 'rev-parse', 'HEAD'),
            sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
            sourceClean: !git(root, 'status', '--porcelain', '--untracked-files=all'),
            sourceEnvironment: { node: process.version, platform: process.platform, arch: process.arch },
            sourceDiff: git(
              root,
              'diff',
              '--',
              'scripts/factory-ui/flow-merge.mjs',
              'scripts/factory-ui/strategy-provider.mjs'
            ),
            fixture:
              'Browser Merge control, Factory executor, and real Git with a disposable bare remote. GitHub responses are simulated.',
            scenarios,
          },
          null,
          2
        ) + '\n'
      );
    });
  } finally {
    service.guard = guard;
    service.flows.observer = observer;
    writeFileSync(configPath, previous);
  }
}
