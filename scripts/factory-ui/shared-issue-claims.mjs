import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { requireThat, writeJson } from './common.mjs';
import { createSharedIssueGit } from './shared-issue-git.mjs';
import { queueClaimPath, readQueueClaim } from './shared-issue-paths.mjs';

export function createSharedIssueClaims({ root, remote = 'origin', target = 'issue-queue', ...options }) {
  const queue = createSharedIssueGit({ root, remote, target, ...options });
  const directory = join(root, '.issues', 'shared-issue-claims');
  const at = (head, id) => readQueueClaim(queue.execute, head, id);
  function recordPath(issueId) {
    queueClaimPath(issueId);
    return join(directory, `${issueId}.json`);
  }
  function own(issueId) {
    try {
      const claim = JSON.parse(readFileSync(recordPath(issueId), 'utf8'));
      requireThat(claim.version === 2, 'Reconcile the legacy remote claim with the previous runner before upgrading.');
      requireThat(
        claim.issueId === issueId &&
          claim.remote === remote &&
          claim.target === target &&
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(claim.oid),
        'The saved issue claim is invalid or belongs to a different queue.'
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
    return locked(issueId, (path) => {
      requireThat(!own(issueId), 'This checkout already has a claim record. Reconcile it before starting again.');
      requireThat(
        !queue.legacyClaims(),
        'Legacy remote claims remain. Stop old runners and reconcile their claims before upgrading.'
      );
      const identity = { version: 2, issueId, attemptId: randomUUID(), runner: hostname(), remote, target };
      const content = JSON.stringify(identity) + '\n';
      const claim = { ...identity, oid: queue.execute(['hash-object', '-w', '--stdin'], content).trim() };
      writeFileSync(path, JSON.stringify(claim) + '\n', { flag: 'wx', mode: 0o600 });
      let head = queue.fetch();
      for (let attempt = 0; attempt < 3; attempt++) {
        assertAvailable(head, issueId, path);
        const commit = queue.commit(head, [[queueClaimPath(issueId), content]], `Claim issue ${issueId}`);
        writeJson(path, { ...claim, commit });
        const next = pushAndRead(commit, head);
        if (at(next, issueId)?.oid === claim.oid) return claim;
        requireThat(
          next !== head,
          'Could not confirm remote claim creation. Reconcile the saved claim before retrying.'
        );
        const published = queue.execute(['merge-base', commit, next]).trim() === commit;
        requireThat(!published, 'The published claim changed. Reconcile it before starting work.');
        head = next;
      }
      throw Error('The shared queue kept changing. Reconcile the saved claim before retrying.');
    });
  }
  function assertAvailable(head, issueId, path) {
    if (!at(head, issueId)) return;
    rmSync(path);
    throw Error('Another run already claims this issue.');
  }
  function pushAndRead(commit, head) {
    try {
      queue.push(commit, head);
    } catch {}
    return queue.fetch();
  }
  function isOwned(head, claim) {
    return at(head, claim.issueId)?.oid === claim.oid;
  }
  function verifyOwn(issueId) {
    const claim = own(issueId);
    return claim && isOwned(queue.fetch(), claim) ? claim : null;
  }
  function release(claim) {
    return locked(claim.issueId, (path) => {
      assertLocalClaim(claim, 'The saved issue claim does not match this run.');
      let head = queue.fetch();
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!isOwned(head, claim)) break;
        const commit = queue.commit(head, [[queueClaimPath(claim.issueId), null]], `Release issue ${claim.issueId}`);
        const next = pushAndRead(commit, head);
        requireThat(
          next !== head || !isOwned(next, claim),
          'Could not release the remote claim. Its record was retained for recovery.'
        );
        head = next;
      }
      requireThat(!isOwned(head, claim), 'The shared queue kept changing. Its claim was retained for recovery.');
      rmSync(path);
      return true;
    });
  }
  function assertLocalClaim(claim, message) {
    requireThat(own(claim.issueId)?.oid === claim.oid, message);
  }
  function forgetReleased(claim) {
    return locked(claim.issueId, (path) => {
      assertLocalClaim(claim, 'The saved issue claim does not match the atomic release.');
      rmSync(path);
      return true;
    });
  }
  function claimsAt(head) {
    const entries = queue.execute(['ls-tree', '-r', head, '--', '.issues/claims/']).trim();
    return new Map(
      entries
        ? entries.split('\n').map((entry) => {
            const id = entry.split('\t')[1]?.match(/^\.issues\/claims\/([\w-]+)\.json$/)?.[1];
            requireThat(id, 'The shared claim directory contains an invalid entry.');
            return [id, at(head, id)];
          })
        : []
    );
  }
  function list() {
    return claimsAt(queue.fetch());
  }
  async function listAsync() {
    return claimsAt(await queue.fetchAsync());
  }
  function readTargetReport(issueId) {
    queueClaimPath(issueId);
    const head = queue.fetch();
    for (const path of [`.issues/${issueId}.md`, `.issues/closed/${issueId}.md`]) {
      const entry = queue.execute(['ls-tree', head, '--', path]).trim();
      if (!entry) continue;
      requireThat(entry.startsWith('100644 blob '), 'The target issue report must be a regular Markdown file.');
      return queue.execute(['show', `${head}:${path}`]);
    }
    return null;
  }
  return { acquire, own, verifyOwn, recover: verifyOwn, release, forgetReleased, list, listAsync, readTargetReport };
}
