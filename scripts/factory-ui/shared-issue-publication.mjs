import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnvironment, readJson, requireThat, writeJson } from './common.mjs';
import { ensureIssueNumbers } from './issue-numbers.mjs';
import { parse } from 'yaml';

const numbersPath = '.issues/issue-numbers.json';
const issueIdPattern = /^\d{8}T\d{6}(?:\d{3})?Z?-[a-f0-9]{4,32}$/;
const objectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function issuePath(issueId, location = 'open') {
  requireThat(typeof issueId === 'string' && issueIdPattern.test(issueId), 'Use a full issue ID for publication.');
  return `.issues/${location === 'closed' ? 'closed/' : ''}${issueId}.md`;
}

function sameReport(left, right) {
  return left.location === right.location && left.report === right.report;
}

function numberFor(numbers, issueId) {
  return numbers && JSON.parse(numbers).issues?.[issueId];
}

function requestedReport(report, location, role = 'checkpoint') {
  const present = ['open', 'closed'].includes(location) && typeof report === 'string' && report.length > 0;
  requireThat(
    present || (report === null && location === null),
    `A queue ${role} needs a report at a valid location or an explicit removal.`
  );
  return { report, location };
}

function checkpointPaths(issueId, from, to) {
  return [
    ...[from, to].filter(Boolean).map((location) => issuePath(issueId, location)),
    ...(to === null ? [] : [numbersPath]),
  ];
}

function verifyReviewedFiles(record, location, files) {
  const from = record.baseLocation === undefined ? 'open' : record.baseLocation;
  const allowed = checkpointPaths(record.issueId, from, location);
  const destination = issuePath(record.issueId, location || from);
  const changedReport = files.some(
    (file) => file.filename === destination && (location !== null || file.status === 'removed')
  );
  requireThat(
    changedReport && files.every((file) => reviewedPath(file, allowed, destination)),
    'The merged queue update PR includes unexpected files.'
  );
}

function reviewedPath(file, allowed, destination) {
  if (!allowed.includes(file.filename)) return false;
  if (!file.previous_filename) return true;
  return (
    file.filename === destination &&
    file.previous_filename !== file.filename &&
    file.previous_filename !== numbersPath &&
    allowed.includes(file.previous_filename)
  );
}

function assertHumanApproval(pr, reviews) {
  const latest = new Map(
    reviews
      .filter(
        (review) =>
          review.user?.type === 'User' && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
      )
      .map((review) => [review.user.id, review])
  );
  requireThat(
    [...latest.values()].some((review) => review.state === 'APPROVED' && review.commit_id === pr.head.sha),
    'The final queue update PR revision has no human approval.'
  );
}

function assertLandedCheckpoint(record, proposed, merged, issueNumber) {
  requireThat(
    sameReport(proposed, merged) && issueNumber === record.issueNumber,
    'The merged report or display number differs from the saved queue checkpoint.'
  );
}

function validPublicationRoute(record) {
  if (record.direct === true) return record.branch === undefined && record.number === undefined;
  return record.branch?.startsWith(`queue-updates/${record.issueId}-`) && /^queue-updates\/[\w-]+$/.test(record.branch);
}

function validatePublicationCommits(record) {
  return ['commit', 'previousCommit', 'mergeCommit'].every((key) => {
    const hash = record[key];
    return key !== 'commit' && [undefined, null].includes(hash) ? true : objectIdPattern.test(hash);
  });
}

function assertReportRemoval(candidate, live) {
  if (candidate.location !== null) return;
  requireThat(
    live.location === 'closed' || (live.location === 'open' && reportState(live.report) === 'needs-approval'),
    'Only a shared closed report or an issue awaiting approval can be removed.'
  );
}

function reportState(report) {
  const [, header] = /^---\r?\n([\s\S]*?)\r?\n---/.exec(report) || [];
  return (parse(header ?? '') || {}).state;
}

function assertPublicationTarget(direct, separateBranch, target) {
  requireThat(!direct || separateBranch === target, 'Direct publishing requires a dedicated queue branch.');
}

export function createSharedIssuePublication({
  root,
  remote,
  target,
  repository,
  requireReview = true,
  direct = false,
  separateBranch,
  pushDirect,
  openPullRequest,
  inspectPullRequest,
  transport,
}) {
  requireThat(typeof remote === 'string' && /^[a-zA-Z0-9][\w.-]*$/.test(remote), 'Configure a shared issue remote.');
  requireThat(typeof target === 'string' && /^[\w/.-]+$/.test(target), 'Configure a shared issue target branch.');
  requireThat(!target.startsWith('queue-updates/'), 'Use a target outside the queue update branch namespace.');
  requireThat(
    typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository),
    'Configure a GitHub repository.'
  );
  const targetRef = `refs/heads/${target}`;
  const snapshotRef = 'refs/worktree/timey/shared-issue-publication-target';
  assertPublicationTarget(direct, separateBranch, target);
  const directory = join(root, '.issues/shared-publication');
  const environment = cleanEnvironment();
  const queueToken = environment.TIMEY_QUEUE_GITHUB_TOKEN;
  delete environment.TIMEY_QUEUE_GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  delete environment.GH_DEBUG;
  Object.assign(environment, { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' });

  function command(program, args, { input, env = {} } = {}) {
    try {
      return execFileSync(program, args, {
        cwd: root,
        encoding: 'utf8',
        input,
        env: {
          ...environment,
          ...(program === 'gh' && queueToken ? { GH_TOKEN: queueToken } : {}),
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      throw Error(`Shared issue publication: ${program} ${args[0]} failed.`, { cause: error });
    }
  }

  const git = (...args) => command('git', args, { env: transport?.environment() }).trim();
  git('check-ref-format', targetRef);

  function assertRemote() {
    if (injectedTransport()) return;
    const allowed = [
      `https://github.com/${repository}.git`,
      `https://github.com/${repository}`,
      `git@github.com:${repository}.git`,
      `git@github.com:${repository}`,
    ].map((url) => url.toLowerCase());
    for (const args of [[remote], ['--push', '--all', remote]]) {
      const urls = git('remote', 'get-url', ...args).split('\n');
      requireThat(
        urls.length === 1 && allowed.includes(urls[0].toLowerCase()),
        'Shared queue remote does not match its configured repository.'
      );
    }
  }

  function injectedTransport() {
    return openPullRequest || pushDirect;
  }

  function remoteHead(ref) {
    const result = git('ls-remote', '--refs', remote, ref);
    if (!result) return null;
    const [head, actualRef] = result.split('\t');
    requireThat(objectIdPattern.test(head) && actualRef === ref, 'Unexpected shared queue branch response.');
    return head;
  }

  function readPath(head, path) {
    const entry = git('ls-tree', head, '--', path);
    if (!entry) return null;
    requireThat(entry.startsWith('100644 blob '), 'Shared queue paths must be regular files.');
    return command('git', ['show', `${head}:${path}`]);
  }

  function readReport(head, issueId) {
    const open = readPath(head, issuePath(issueId));
    const closed = readPath(head, issuePath(issueId, 'closed'));
    requireThat(open === null || closed === null, 'The target contains both open and closed copies of this report.');
    if (open !== null) return { report: open, location: 'open' };
    if (closed !== null) return { report: closed, location: 'closed' };
    return { report: null, location: null };
  }

  function readTarget(issueId) {
    issuePath(issueId);
    assertRemote();
    git('fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', remote, `+${targetRef}:${snapshotRef}`);
    const head = git('rev-parse', '--verify', snapshotRef);
    return { head, ...readReport(head, issueId), numbers: readPath(head, numbersPath) };
  }

  function prepare(issueId, candidate, live) {
    const temporary = mkdtempSync(join(tmpdir(), 'timey-queue-'));
    try {
      mkdirSync(join(temporary, '.issues'));
      if (live.numbers !== null) writeFileSync(join(temporary, numbersPath), live.numbers);
      const issueNumber =
        candidate.location === null
          ? numberFor(live.numbers, issueId)
          : ensureIssueNumbers(temporary, [issueId])[issueId];
      requireThat(Number.isSafeInteger(issueNumber), 'The archived report needs an existing display number.');
      const index = { GIT_INDEX_FILE: join(temporary, 'index') };
      const indexGit = (...args) => command('git', args, { env: index }).trim();
      indexGit('read-tree', live.head);
      updateIndex(indexGit, issueId, candidate, live, temporary);
      const tree = indexGit('write-tree');
      const changed = git('diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', live.head, tree).split(
        '\n'
      );
      requireThat(
        changed.every((path) => checkpointPaths(issueId, live.location, candidate.location).includes(path)),
        'Queue checkpoint includes unexpected files.'
      );
      const commit = git('commit-tree', tree, '-p', live.head, '-m', `Update issue report ${issueId}`);
      return { commit, issueNumber, location: candidate.location, baseLocation: live.location };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  function updateIndex(indexGit, issueId, candidate, live, temporary) {
    if (live.location && live.location !== candidate.location)
      indexGit('update-index', '--force-remove', '--', issuePath(issueId, live.location));
    if (candidate.location === null) return;
    for (const [path, content] of [
      [issuePath(issueId, candidate.location), candidate.report],
      [numbersPath, readFileSync(join(temporary, numbersPath), 'utf8')],
    ]) {
      const blob = command('git', ['hash-object', '-w', '--stdin'], { input: content }).trim();
      indexGit('update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
    }
  }

  function ensurePullRequest(record) {
    if (openPullRequest) return openPullRequest(record);
    const owner = repository.split('/')[0];
    const endpoint = `repos/${repository}/pulls`;
    const existing = JSON.parse(
      command('gh', [
        'api',
        endpoint,
        '--method',
        'GET',
        '-f',
        'state=all',
        '-f',
        `head=${owner}:${record.branch}`,
        '-f',
        `base=${target}`,
      ])
    );
    requireThat(
      existing.length <= 1,
      'Multiple queue update PRs match this publication. Reconcile them before continuing.'
    );
    const pr =
      existing[0] ??
      JSON.parse(
        command('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], {
          input: JSON.stringify({
            head: record.branch,
            base: target,
            title: `Update issue report ${record.issueId}`,
            body: `Queue checkpoint for ${record.issueId}.`,
          }),
        })
      );
    requireThat(
      pr.state === 'open' &&
        pr.head.sha === record.commit &&
        pr.head.ref === record.branch &&
        pr.base.ref === target &&
        pr.base.repo.full_name.toLowerCase() === repository.toLowerCase() &&
        pr.head.repo?.full_name.toLowerCase() === repository.toLowerCase(),
      'The queue update PR changed or is no longer open. Reconcile it before continuing.'
    );
    return { url: pr.html_url, number: pr.number };
  }

  const pendingPath = (issueId) => {
    issuePath(issueId);
    return join(directory, `${issueId}.json`);
  };

  function readPending(issueId) {
    try {
      const record = readJson(pendingPath(issueId));
      validatePublicationRecord(issueId, record);
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function validatePublicationRecord(issueId, record) {
    const identity = { issueId, remote, target, repository };
    const matches = Object.entries(identity).every(([key, value]) => record[key] === value);
    requireThat(
      matches && validatePublicationCommits(record) && validPublicationRoute(record),
      'Queue checkpoint configuration changed. Reconcile the pending record before continuing.'
    );
  }

  function listPending() {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => readPending(name.slice(0, -5)))
      .filter(Boolean);
  }

  function inspect(issueId, head) {
    const record = readPending(issueId);
    if (!record) return null;
    const live = head
      ? { head, ...readReport(head, issueId), numbers: readPath(head, numbersPath) }
      : readTarget(issueId);
    return inspectTarget(record, live);
  }

  function inspectTarget(record, live) {
    if (record.mergeCommit) {
      git('merge-base', '--is-ancestor', record.mergeCommit, live.head);
      return { ...record, status: 'landed' };
    }
    return record.direct ? inspectDirect(record, live.head) : inspectPullRequestTarget(record, live);
  }

  function inspectDirect(record, head) {
    if (git('merge-base', record.commit, head) !== record.commit) return { ...record, status: 'pending' };
    return {
      ...record,
      status: 'landed',
      mergeCommit: record.commit,
      url: `https://github.com/${repository}/commit/${record.commit}`,
    };
  }

  function inspectPullRequestTarget(record, live) {
    const landed =
      numberFor(live.numbers, record.issueId) === record.issueNumber &&
      sameReport(live, readReport(record.commit, record.issueId));
    return { ...record, status: landed ? 'landed' : 'pending' };
  }

  function pullRequestDetails(record) {
    if (inspectPullRequest) return inspectPullRequest(record);
    const path = `repos/${repository}/pulls/${record.number}`;
    const list = (kind) => JSON.parse(command('gh', ['api', '--paginate', '--slurp', `${path}/${kind}`])).flat();
    return {
      pr: JSON.parse(command('gh', ['api', path])),
      files: list('files'),
      reviews: requireReview ? list('reviews') : [],
    };
  }

  function confirmMerged(issueId) {
    if (openPullRequest && !inspectPullRequest) {
      const record = inspect(issueId);
      requireThat(record?.status === 'landed', 'The queue update PR has not landed.');
      return record;
    }
    return withPublicationLock(issueId, (recordPath) => {
      const record = readPending(issueId);
      requireThat(Number.isSafeInteger(record?.number) && record.number > 0, 'No queue update PR is recorded.');
      const live = readTarget(issueId);
      const { pr, files, reviews } = pullRequestDetails(record);
      requireThat(
        pr.number === record.number &&
          pr.merged === true &&
          objectIdPattern.test(pr.merge_commit_sha) &&
          pr.head.ref === record.branch &&
          pr.head.repo?.full_name.toLowerCase() === repository.toLowerCase() &&
          pr.base.ref === target &&
          pr.base.repo.full_name.toLowerCase() === repository.toLowerCase(),
        'The recorded queue update PR has not been verified as merged into the target.'
      );
      if (requireReview) assertHumanApproval(pr, reviews);
      else requireThat(pr.head.sha === record.commit, 'The queue update PR head changed before merge.');
      const proposed = readReport(record.commit, issueId);
      verifyReviewedFiles(record, proposed.location, files);
      git('merge-base', '--is-ancestor', pr.merge_commit_sha, live.head);
      const merged = readReport(pr.merge_commit_sha, issueId);
      const issueNumber = numberFor(live.numbers, issueId);
      requireThat(
        proposed.location === merged.location && Number.isSafeInteger(issueNumber),
        'The merged report location or display number differs from the approved queue operation.'
      );
      if (!requireReview) assertLandedCheckpoint(record, proposed, merged, issueNumber);
      const confirmed = { ...record, status: 'landed', issueNumber, mergeCommit: pr.merge_commit_sha };
      writeJson(recordPath, confirmed);
      return confirmed;
    });
  }

  function publish({ issueId, base, report, reason, location = 'open' }, refresh = false) {
    const candidate = requestedReport(report, location);
    const expected =
      typeof base === 'object' && base !== null
        ? { report: base.report, location: base.location ?? (base.report === null ? null : 'open') }
        : { report: base, location: base === null ? null : 'open' };
    requestedReport(expected.report, expected.location, 'base');
    return withPublicationLock(issueId, (path) => {
      const live = readTarget(issueId);
      let record = publicationRecord(issueId, candidate, expected, reason, live, path);
      if (record.status === 'landed') {
        if (record.direct) writeJson(path, record);
        return record;
      }
      if (record.direct) return publishDirect(record, candidate, expected, live, path);
      record = pushCheckpoint(record, expected, path, refresh);
      const result = { ...record, ...ensurePullRequest(record), status: 'pending' };
      delete result.previousCommit;
      writeJson(path, result);
      return result;
    });
  }

  function publicationRecord(issueId, candidate, expected, reason, live, path) {
    const previous = readPending(issueId);
    const status = previous && inspectTarget(previous, live);
    if (status?.status === 'pending') {
      requireThat(
        sameReport(readReport(previous.commit, issueId), candidate) &&
          sameReport(readReport(git('rev-parse', `${previous.commit}^`), issueId), expected),
        'A different report checkpoint is already pending.'
      );
      return previous;
    }
    if (
      status &&
      sameReport(live, candidate) &&
      sameReport(readReport(status.mergeCommit || status.commit, issueId), candidate)
    )
      return status;
    requireThat(sameReport(live, expected), 'The shared report changed. Reconcile it before publishing.');
    const number = numberFor(live.numbers, issueId);
    if (sameReport(live, candidate) && Number.isSafeInteger(number))
      return { issueId, status: 'landed', issueNumber: number };
    assertReportRemoval(candidate, live);
    const record = {
      ...prepare(issueId, candidate, live),
      issueId,
      reason,
      remote,
      target,
      repository,
      ...(direct ? { direct: true } : { branch: `queue-updates/${issueId}-${randomUUID()}` }),
    };
    writeJson(path, record);
    return record;
  }

  function publishDirect(record, candidate, expected, live, path) {
    for (let attempt = 0; attempt < 3; attempt++) {
      requireThat(sameReport(live, expected), 'The shared report changed. Reconcile it before publishing.');
      record = prepareDirectRetry(record, candidate, live, path);
      const pushError = attemptDirectPush(record.commit);
      const next = readTarget(record.issueId);
      const landed = inspectTarget(record, next);
      if (landed.status === 'landed') {
        writeJson(path, landed);
        return landed;
      }
      if (next.head === live.head) throw pushError;
      live = next;
    }
    throw Error('The shared queue kept changing. Retry publication.');
  }

  function prepareDirectRetry(record, candidate, live, path) {
    if (git('rev-parse', `${record.commit}^`) === live.head) return record;
    const updated = { ...record, ...prepare(record.issueId, candidate, live) };
    writeJson(path, updated);
    return updated;
  }

  function attemptDirectPush(commit) {
    try {
      (pushDirect ?? pushWithApp)(commit, targetRef);
    } catch (error) {
      return error;
    }
    return Error('Git did not confirm the direct queue push. Retry publication.');
  }

  function pushWithApp(commit) {
    try {
      command(process.execPath, [fileURLToPath(new URL('./shared-issue-app-push.mjs', import.meta.url))], {
        input: JSON.stringify({ repository, targetRef, commit }),
      });
    } catch (error) {
      if (error.cause?.status === 2) throw Error('Could not authenticate as the Timey Software Factory GitHub App.');
      throw Error(
        'The Timey Software Factory GitHub App could not push to the queue branch. Check its GitHub ruleset.'
      );
    }
  }

  function pushCheckpoint(record, expected, path, refresh) {
    const ref = `refs/heads/${record.branch}`;
    assertRemote();
    const existing = remoteHead(ref);
    let expectedCommit = record.previousCommit ?? null;
    requireThat(
      (existing === expectedCommit && (existing !== null || !record.number)) || existing === record.commit,
      'The queue update branch changed. Reconcile it before continuing.'
    );
    if (refresh) {
      const live = readTarget(record.issueId);
      const priorBase = git('rev-parse', `${record.commit}^`);
      requireThat(
        sameReport(live, expected) && sameReport(live, readReport(priorBase, record.issueId)),
        'The shared report changed. Reconcile the report contents before refreshing its checkpoint.'
      );
      if (live.head !== priorBase) {
        expectedCommit = existing;
        record = {
          ...record,
          ...prepare(record.issueId, readReport(record.commit, record.issueId), live),
          previousCommit: expectedCommit,
        };
        writeJson(path, record);
      }
    }
    if (existing !== record.commit) pushExact(record, ref, expectedCommit);
    return record;
  }

  function pushExact(record, ref, expectedCommit) {
    try {
      git(
        'push',
        '--no-follow-tags',
        '--recurse-submodules=no',
        `--force-with-lease=${ref}:${expectedCommit ?? ''}`,
        remote,
        `${record.commit}:${ref}`
      );
    } catch (error) {
      if (remoteHead(ref) !== record.commit) throw error;
    }
  }

  function withPublicationLock(issueId, operation) {
    const path = pendingPath(issueId);
    mkdirSync(directory, { recursive: true });
    const lock = `${path}.lock`;
    mkdirSync(lock);
    try {
      return operation(path);
    } finally {
      rmSync(lock, { recursive: true });
    }
  }

  return {
    readTarget,
    publish: (request) => publish(request),
    reprepare: (request) => publish(request, true),
    inspect,
    confirmMerged,
    listPending,
  };
}
