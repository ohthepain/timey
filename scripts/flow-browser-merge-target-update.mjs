import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';
import { createFlowExecutor, executeCommand } from './factory-ui/flow-executor.mjs';
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

function listPRs(remote, prs, query, recordMetadata) {
  const branch = new URLSearchParams(query).get('head').split(':').at(-1);
  const pr = [...prs.values()].find((item) => item.branch === branch);
  if (!pr) return [];
  if (recordMetadata) pr.events.push({ action: 'PR metadata read', head: prMetadata(remote, pr).head.sha });
  return [prMetadata(remote, pr)];
}

function gitHubCommit(remote, commit) {
  const [tree, ...parents] = git(remote, 'show', '-s', '--format=%T %P', commit).split(' ');
  return { sha: commit, tree: { sha: tree }, parents: parents.map((sha) => ({ sha })) };
}

function githubFixture(project, remote, writer, prs, recordMetadata = true) {
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
    [/^\/pulls\?(.*)$/, (_, query) => listPRs(remote, prs, query, recordMetadata)],
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
  const { number, title, issueFile, targetFile, advanceAtMerge, rejectPush } = scenario;
  const branch = 'codex/merge-proof-' + number;
  const checkout = join(project, '.issues/issue-work', '20261126-merge-proof-' + number);
  const base = remoteHead(remote, targetRef);
  git(writer, 'fetch', remote, targetRef);
  git(writer, 'checkout', '--detach', 'FETCH_HEAD');
  git(project, 'worktree', 'add', '-b', branch, checkout, base);
  const initialHead = commitFile(checkout, issueFile, issueLine);
  git(checkout, 'push', remote, 'HEAD:refs/heads/' + branch);
  const pr = { number, branch, checkout, initialHead, events: [], advanceAtMerge, rejectPush };
  pr.initialTarget = advanceTarget(remote, writer, targetFile, targetLine, pr.events);
  return savePRFlow(flows, project, remote, pr, base, title);
}

function executeFetch(input, remote, pr) {
  const { cwd, args, log } = input;
  if (log.endsWith('/command.log'))
    return executeCommand({
      ...input,
      command: process.execPath,
      args: ['-e', 'console.error("The quasar index returned QX-19."); process.exitCode = 17'],
    });
  const output = git(cwd, ...args.map((arg) => (arg === config.remote ? remote : arg)));
  pr.events.push({ action: 'Target fetched', target: remoteHead(remote, targetRef) });
  return output;
}

function mergeExecutor(service, provider, remote, currentPR) {
  let waits = 0;
  return createFlowExecutor(service, {
    provider,
    async execute(input) {
      const { command, cwd, args, log } = input;
      assert.equal(command, 'git');
      appendFileSync(log, '$ git ' + args.join(' ') + '\n');
      if (args[0] === 'fetch') return executeFetch(input, remote, currentPR());
      if (args[0] !== 'push') return git(cwd, ...args);
      const [head] = args[2].split(':');
      if (currentPR().rejectPush) {
        const hook = join(remote, 'hooks', 'pre-receive');
        writeFileSync(hook, '#!/bin/sh\necho "GH006: protected branch update failed" >&2\nexit 1\n');
        chmodSync(hook, 0o755);
        currentPR().events.push({ action: 'Issue push attempted', head });
        return executeCommand({ ...input, args: ['push', remote, ...args.slice(2)] });
      }
      const result = git(cwd, 'push', remote, ...args.slice(2));
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

async function runBlock({ page, service, id, block, poll, selectBlock, clickAction }) {
  const current = () => service.flows.read(service.flows.selected(id)).blocks.find(({ id }) => id === block.id);
  await page.goto('/?issue=' + id);
  await selectBlock(block.id);
  await clickAction(page.locator('#run-block'));
  return poll(
    () => current().attempts.at(-1),
    (attempt) => attempt?.endedAt && !service.flows.active.has(id),
    'The block did not finish.'
  );
}

async function runMergeControl(harness) {
  const { page, merge, pr, screenshot, selectBlock } = harness;
  const completed = await runBlock({ ...harness, block: merge });
  assert.equal(completed.status, 'completed', completed.summary);
  assert.equal(completed.result.revision, pr.merge);
  const landed = pr.events.at(-1);
  assert.equal(landed.action, 'GitHub merged');
  assert.equal(completed.result.head, landed.head);
  assertPublicationOrder(pr.events);
  await page.reload();
  await selectBlock(merge.id);
  await screenshot('merge-target-update-' + pr.number);
  return completed.result;
}

function assertPublicationOrder(events) {
  assert.equal(events[1].action, 'Target fetched');
  const pushed = new Set();
  for (const { action, head } of events) {
    if (action === 'Issue head pushed') pushed.add(head);
    if (['GitHub readiness verified', 'GitHub test merge requested'].includes(action)) assert.ok(pushed.has(head));
  }
}

function assertConflictDelivery(remote, pr, result) {
  const repair = pr.events.find((event) => event.action === 'Owning issue repair committed');
  assert.equal(repair?.head, result.head);
  assert.ok(pr.events.indexOf(repair) < pr.events.findIndex((event) => event.action === 'PR metadata read'));
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
  {
    number: 73,
    title: 'Update without conflicts or target drift',
    issueFile: 'issue-73.txt',
    targetFile: 'target-73.txt',
    contents: { 'issue-73.txt': issueLine.trim(), 'target-73.txt': targetLine.trim() },
    assertDelivery(_remote, pr, result) {
      assert.equal(result.target, pr.initialTarget);
      assert.equal(pr.events.filter(({ action }) => action === 'Issue head pushed').length, 1);
    },
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

async function inspectFailure({ page, selectBlock, screenshot }, block, attempt, expected, explanation) {
  assert.equal(attempt.status, 'blocked', attempt.summary);
  await page.reload();
  await selectBlock(block.id);
  const card = page.locator(`[data-attempt-id="${attempt.id}"] .command-error`).filter({ hasText: expected }).first();
  const original = await card.locator('pre').textContent();
  if (explanation) await card.getByText(explanation, { exact: true }).waitFor();
  else assert.equal(await card.locator('.detail-copy').count(), 0);
  await screenshot('blocked-command-' + block.kind);
  const open = page.waitForEvent('popup');
  await card.getByRole('link', { name: 'Open full log' }).click();
  const log = await open;
  const full = await log.locator('pre').textContent();
  assert.ok(full.includes(expected));
  await log.close();
  return { block: block.kind, explanation, original, full };
}

async function verifyFailedPush(harness, remote, writer, prs, setPR) {
  const { service, project } = harness;
  const { id, pr, merge } = await preparePR(service.flows, project, remote, writer, {
    number: 74,
    title: 'A failed push blocks Merge',
    issueFile: 'issue-74.txt',
    targetFile: 'target-74.txt',
    rejectPush: true,
  });
  setPR(pr);
  prs.set(pr.number, pr);
  const mergeAttempt = await runBlock({ ...harness, id, block: merge });
  const mergeLog = await inspectFailure(
    harness,
    merge,
    mergeAttempt,
    'GH006: protected branch update failed',
    'GitHub rejected the change because a branch rule was not met. The log shows which rule blocked it.'
  );
  assert.equal(remoteHead(remote, 'refs/heads/' + pr.branch), pr.initialHead);
  assert.equal(git(pr.checkout, 'merge-base', 'HEAD', pr.initialTarget), pr.initialTarget);
  assert.ok(pr.events.some(({ action }) => action === 'Issue push attempted'));
  assert.ok(pr.events.every(({ action }) => !action.startsWith('GitHub')));
  const saved = service.flows.read(service.flows.selected(id));
  const { flow } = await service.flows.action({
    action: 'add',
    issueId: id,
    revision: saved.revision,
    kind: 'update-branch',
    afterId: 'work',
  });
  const update = flow.blocks.find(({ kind }) => kind === 'update-branch');
  const updateAttempt = await runBlock({ ...harness, id, block: update });
  const updateLog = await inspectFailure(harness, update, updateAttempt, 'The quasar index returned QX-19.');
  return { events: pr.events, mergeLog, updateLog };
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
      service.flows.observer = createFlowObserver(service, {
        provider: githubFixture(project, remote, writer, prs, false),
      });
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
      const blocked = await verifyFailedPush(harness, remote, writer, prs, (pr) => (activePR = pr));
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
            blocked,
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
