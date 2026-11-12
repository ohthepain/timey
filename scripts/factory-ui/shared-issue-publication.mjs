import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnvironment, readJson, requireThat, writeJson } from './common.mjs';
import { ensureIssueNumbers } from './issue-numbers.mjs';

const numbersPath = '.issues/issue-numbers.json';
const issueIdPattern = /^\d{8}T\d{6}(?:\d{3})?Z?-[a-f0-9]{4,32}$/;
const objectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function issuePath(issueId) {
  requireThat(typeof issueId === 'string' && issueIdPattern.test(issueId), 'Use a full issue ID for publication.');
  return `.issues/${issueId}.md`;
}

export function createSharedIssuePublication({
  root,
  remote,
  target,
  repository,
  openPullRequest,
  inspectPullRequest,
}) {
  requireThat(typeof remote === 'string' && /^[a-zA-Z0-9][\w.-]*$/.test(remote), 'Configure a shared issue remote.');
  requireThat(typeof target === 'string' && /^[\w/.-]+$/.test(target), 'Configure a shared issue target branch.');
  requireThat(!target.startsWith('queue-updates/'), 'Use a target outside the queue update branch namespace.');
  requireThat(
    typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository),
    'Configure a GitHub repository.'
  );
  const targetRef = `refs/heads/${target}`;
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
        env: { ...environment, ...(program === 'gh' && queueToken ? { GH_TOKEN: queueToken } : {}), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      throw Error(`Shared issue publication: ${program} ${args[0]} failed.`, { cause: error });
    }
  }

  const git = (...args) => command('git', args).trim();
  git('check-ref-format', targetRef);

  function assertRemote() {
    if (openPullRequest) return;
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

  function readTarget(issueId) {
    const reportPath = issuePath(issueId);
    assertRemote();
    const head = remoteHead(targetRef);
    requireThat(head, 'The shared issue target branch could not be found.');
    git('fetch', '--no-tags', '--no-write-fetch-head', remote, head);
    return { head, report: readPath(head, reportPath), numbers: readPath(head, numbersPath) };
  }

  function prepare(issueId, report, live) {
    const temporary = mkdtempSync(join(tmpdir(), 'timey-queue-'));
    try {
      mkdirSync(join(temporary, '.issues'));
      if (live.numbers !== null) writeFileSync(join(temporary, numbersPath), live.numbers);
      const issueNumber = ensureIssueNumbers(temporary, [issueId])[issueId];
      const numbers = readFileSync(join(temporary, numbersPath), 'utf8');
      const index = { GIT_INDEX_FILE: join(temporary, 'index') };
      const indexGit = (...args) => command('git', args, { env: index }).trim();
      indexGit('read-tree', live.head);
      for (const [path, content] of [
        [issuePath(issueId), report],
        [numbersPath, numbers],
      ]) {
        const blob = command('git', ['hash-object', '-w', '--stdin'], { input: content }).trim();
        indexGit('update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
      }
      const tree = indexGit('write-tree');
      const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', live.head, tree).split('\n');
      requireThat(
        changed.every((path) => path === issuePath(issueId) || path === numbersPath),
        'Queue checkpoint includes unexpected files.'
      );
      const commit = git('commit-tree', tree, '-p', live.head, '-m', `Update issue report ${issueId}`);
      return { commit, issueNumber };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
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
            body: `Queue checkpoint for ${record.issueId}. This report update requires human review before merging.`,
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
      requireThat(
        record.issueId === issueId &&
          record.remote === remote &&
          record.target === target &&
          record.repository === repository &&
          objectIdPattern.test(record.commit) &&
          (!record.previousCommit || objectIdPattern.test(record.previousCommit)) &&
          (!record.mergeCommit || objectIdPattern.test(record.mergeCommit)) &&
          record.branch.startsWith(`queue-updates/${issueId}-`) &&
          /^queue-updates\/[\w-]+$/.test(record.branch),
        'Queue checkpoint configuration changed. Reconcile the pending record before continuing.'
      );
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
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

  function inspect(issueId) {
    const record = readPending(issueId);
    if (!record) return null;
    const live = readTarget(issueId);
    if (record.mergeCommit) {
      git('merge-base', '--is-ancestor', record.mergeCommit, live.head);
      return { ...record, status: 'landed' };
    }
    const issueNumber = live.numbers && JSON.parse(live.numbers).issues?.[issueId];
    const landed = issueNumber === record.issueNumber && live.report === readPath(record.commit, issuePath(issueId));
    return { ...record, status: landed ? 'landed' : 'pending' };
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
      const path = `repos/${repository}/pulls/${record.number}`;
      const details = inspectPullRequest?.(record) ?? {
        pr: JSON.parse(command('gh', ['api', path])),
        files: JSON.parse(command('gh', ['api', '--paginate', '--slurp', `${path}/files`])).flat(),
        reviews: JSON.parse(command('gh', ['api', '--paginate', '--slurp', `${path}/reviews`])).flat(),
      };
      const { pr, files, reviews } = details;
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
      const latestReviews = new Map();
      for (const review of reviews) {
        if (review.user?.type === 'User' && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
          latestReviews.set(review.user.id, review);
        }
      }
      requireThat(
        [...latestReviews.values()].some((review) => review.state === 'APPROVED' && review.commit_id === pr.head.sha),
        'The final queue update PR revision has no human approval.'
      );
      const allowedPaths = [issuePath(issueId), numbersPath];
      requireThat(
        files.some((file) => file.filename === issuePath(issueId)) &&
          files.every((file) => allowedPaths.includes(file.filename) && !file.previous_filename),
        'The merged queue update PR includes unexpected files.'
      );
      git('merge-base', '--is-ancestor', pr.merge_commit_sha, live.head);
      const issueNumber = live.numbers && JSON.parse(live.numbers).issues?.[issueId];
      requireThat(
        live.report !== null && Number.isSafeInteger(issueNumber),
        'The merged report is absent from the target.'
      );
      const confirmed = { ...record, status: 'landed', issueNumber, mergeCommit: pr.merge_commit_sha };
      writeJson(recordPath, confirmed);
      return confirmed;
    });
  }

  function publish({ issueId, base, report, reason }, refresh = false) {
    requireThat(typeof report === 'string' && report.length > 0, 'A queue checkpoint needs an issue report.');
    const expectedReport = typeof base === 'object' && base !== null ? base.report : base;
    requireThat(
      expectedReport === null || typeof expectedReport === 'string',
      'A queue checkpoint needs the expected target report.'
    );
    return withPublicationLock(issueId, (path) => {
      let record = inspect(issueId);
      if (record?.status === 'landed' && readPath(record.mergeCommit || record.commit, issuePath(issueId)) === report) {
        return record;
      }
      if (!record || record.status === 'landed') {
        const live = readTarget(issueId);
        requireThat(live.report === expectedReport, 'The shared report changed. Reconcile it before publishing.');
        if (
          live.report === report &&
          live.numbers &&
          Number.isSafeInteger(JSON.parse(live.numbers).issues?.[issueId])
        ) {
          return { issueId, status: 'landed', issueNumber: JSON.parse(live.numbers).issues[issueId] };
        }
        record = {
          ...prepare(issueId, report, live),
          issueId,
          reason,
          remote,
          target,
          repository,
          branch: `queue-updates/${issueId}-${randomUUID()}`,
        };
        writeJson(path, record);
      }
      requireThat(
        readPath(record.commit, issuePath(issueId)) === report,
        'A different report checkpoint is already pending.'
      );
      record = pushCheckpoint(record, expectedReport, path, refresh);
      const result = { ...record, ...ensurePullRequest(record), status: 'pending' };
      delete result.previousCommit;
      writeJson(path, result);
      return result;
    });
  }

  function pushCheckpoint(record, expectedReport, path, refresh) {
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
        live.report === expectedReport && live.report === readPath(priorBase, issuePath(record.issueId)),
        'The shared report changed. Reconcile the report contents before refreshing its checkpoint.'
      );
      if (live.head !== priorBase) {
        expectedCommit = existing;
        record = {
          ...record,
          ...prepare(record.issueId, readPath(record.commit, issuePath(record.issueId)), live),
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
