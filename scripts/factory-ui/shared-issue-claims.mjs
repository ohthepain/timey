import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { cleanEnvironment, git, requireThat } from './common.mjs';

const namespace = 'refs/heads/claims/';
const issuePattern = /^[a-zA-Z0-9_-]{1,100}$/;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function claimRef(issueId) {
  requireThat(typeof issueId === 'string' && issuePattern.test(issueId), 'Select a valid issue.');
  return namespace + issueId;
}

export function createSharedIssueClaims({ root, remote = 'origin', target = 'dev' }) {
  requireThat(typeof remote === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(remote), 'Invalid queue remote.');
  const targetRef = `refs/heads/${target}`;
  git(root, 'check-ref-format', targetRef);
  requireThat(!targetRef.startsWith(namespace), 'Queue target cannot be a claim branch.');
  const directory = join(root, '.issues', 'shared-issue-claims');

  function execute(args, input) {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...cleanEnvironment(), GIT_TERMINAL_PROMPT: '0' },
      stdio: 'pipe',
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      input,
    });
  }

  function refs(pattern) {
    const output = execute(['ls-remote', '--heads', '--', remote, pattern]).trim();
    return output ? output.split('\n').map((line) => line.split('\t')) : [];
  }

  function remoteOid(ref) {
    return refs(ref).find(([, name]) => name === ref)?.[0] ?? null;
  }

  function recordPath(issueId) {
    claimRef(issueId);
    return join(directory, `${issueId}.json`);
  }

  function own(issueId) {
    const path = recordPath(issueId);
    try {
      const claim = JSON.parse(readFileSync(path, 'utf8'));
      requireThat(
        claim.issueId === issueId &&
          claim.remote === remote &&
          typeof claim.oid === 'string' &&
          oidPattern.test(claim.oid),
        'The saved issue claim is invalid or belongs to a different remote.'
      );
      return claim;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function locked(issueId, operation) {
    const path = recordPath(issueId);
    const lock = path + '.lock';
    mkdirSync(directory, { recursive: true });
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error.code === 'EEXIST') throw Error('An issue claim operation is pending. Reconcile it before retrying.');
      throw error;
    }
    try {
      return operation(path);
    } finally {
      rmdirSync(lock);
    }
  }

  function acquire(issueId) {
    const ref = claimRef(issueId);
    return locked(issueId, (path) => {
      requireThat(!own(issueId), 'This checkout already has a claim record. Reconcile it before starting again.');
      requireThat(!remoteOid(ref), 'Another run already claims this issue.');
      const identity = { issueId, attemptId: randomUUID(), runner: hostname(), remote };
      const tree = execute(['mktree'], '').trim();
      const oid = execute([
        '-c',
        'user.name=Timey Factory',
        '-c',
        'user.email=factory@timey.invalid',
        'commit-tree',
        tree,
        '-m',
        JSON.stringify(identity),
      ]).trim();
      const claim = { ...identity, oid };
      writeFileSync(path, JSON.stringify(claim) + '\n', { flag: 'wx', mode: 0o600 });

      try {
        execute([
          'push',
          '--no-follow-tags',
          '--recurse-submodules=no',
          `--force-with-lease=${ref}:`,
          '--',
          remote,
          `${oid}:${ref}`,
        ]);
        return claim;
      } catch {
        const current = remoteOid(ref);
        if (current === oid) return claim;
        if (current) {
          rmSync(path);
          throw Error('Another run already claims this issue.');
        }
        throw Error('Could not confirm remote claim creation. Reconcile the saved claim before retrying.');
      }
    });
  }

  function verifyOwn(issueId) {
    const claim = own(issueId);
    return claim && remoteOid(claimRef(issueId)) === claim.oid ? claim : null;
  }

  function release(claim) {
    const { issueId, oid } = claim;
    const ref = claimRef(issueId);
    return locked(issueId, (path) => {
      requireThat(own(issueId)?.oid === oid && oidPattern.test(oid), 'The saved issue claim does not match this run.');
      if (remoteOid(ref) === oid) {
        try {
          execute([
            'push',
            '--no-follow-tags',
            '--recurse-submodules=no',
            `--force-with-lease=${ref}:${oid}`,
            '--',
            remote,
            `:${ref}`,
          ]);
        } catch {
          requireThat(
            remoteOid(ref) !== oid,
            'Could not release the remote claim. Its record was retained for recovery.'
          );
        }
      }
      rmSync(path);
      return true;
    });
  }

  function list() {
    const claims = new Map();
    for (const [oid, ref] of refs(namespace + '*')) {
      if (!ref?.startsWith(namespace) || !oidPattern.test(oid)) continue;
      const issueId = ref.slice(namespace.length);
      if (issuePattern.test(issueId)) claims.set(issueId, { issueId, oid });
    }
    return claims;
  }

  function readTargetReport(issueId) {
    claimRef(issueId);
    const fetched = `refs/remotes/${remote}/${target}`;
    execute(['fetch', '--no-tags', '--no-write-fetch-head', '--', remote, `+${targetRef}:${fetched}`]);
    const revision = git(root, 'rev-parse', '--verify', fetched);
    const path = `.issues/${issueId}.md`;
    const entry = git(root, 'ls-tree', revision, '--', path);
    if (!entry) return null;
    requireThat(entry.startsWith('100644 blob '), 'The target issue report must be a regular Markdown file.');
    return execute(['show', `${revision}:${path}`]);
  }

  return { acquire, own, verifyOwn, recover: verifyOwn, release, list, readTargetReport };
}
