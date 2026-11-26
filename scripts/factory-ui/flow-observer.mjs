import { observePRReview } from './flow-human-input.mjs';
import { pendingIssueMerge } from './flow-merge-state.mjs';
import { deliveryTarget } from './flow-block-data.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnvironment, digest, readJson, writeJson } from './common.mjs';
import { StrategyProvider } from './strategy-provider.mjs';
import { flowPRLink, lookupFlowPR } from './flow-delivery.mjs';
import { startingBranchUpstream } from './flow-update-branch.mjs';
import { mergedDelivery } from './merged-issue.mjs';

const execute = promisify(execFile);
export async function flowGit(root, ...args) {
  const { stdout } = await execute('git', ['-C', root, ...args], {
    env: { ...cleanEnvironment(), GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}
export function flowTarget(root) {
  const file = join(root, '.issues/issue-delivery-config.json');
  if (existsSync(file)) {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    return { remote: config.remote || 'origin', branch: config.target || 'dev', base: null };
  }
  return { remote: 'origin', branch: 'dev', base: null };
}
export function flowWorkspace(service, flow) {
  const record = service.lifecycleRuns?.[flow.issueId];
  return flow.workspace || record?.work || record?.chatCheckout || null;
}
export function createFlowObserver(service, options = {}) {
  const remote = new Map();
  async function observe(flow, { refresh = false } = {}) {
    const workspace = flowWorkspace(service, flow);
    const checkout = workspace?.checkout;
    const root = checkout && existsSync(checkout) ? checkout : service.root;
    const result = {
      observedAt: new Date().toISOString(),
      worktreeExists: checkout ? existsSync(checkout) : null,
      targetBranch: deliveryTarget(flow).branch,
      pr: null,
    };
    const queries = await Promise.allSettled([
      flowGit(root, 'branch', '--show-current'),
      flowGit(root, 'rev-parse', 'HEAD'),
      flowGit(root, 'status', '--porcelain', '--untracked-files=normal'),
      deliveryTarget(flow).branch ? resolveTarget(service.root, deliveryTarget(flow)) : null,
    ]);
    const [branch, head, dirty, targetState] = queries.map((entry) =>
      entry.status === 'fulfilled' ? entry.value : null
    );
    const target = targetState?.revision;
    Object.assign(result, {
      branch: result.worktreeExists ? branch : workspace?.branch || null,
      sourceBranch: checkout ? null : branch,
      head: checkout && !result.worktreeExists ? null : head,
      dirty: (checkout && !result.worktreeExists) || dirty === null ? null : Boolean(dirty),
      targetRevision: target,
      localTargetRevision: targetState?.localRevision,
    });
    observePendingMerge(checkout, result);
    const failures = queries.filter((entry) => entry.status === 'rejected');
    if (failures.length) result.error = failures.map((entry) => entry.reason.message).join('\n');
    await observeStartingBranch(root, flow, result).catch(() => {});
    if (target && checkout && result.worktreeExists) {
      try {
        const [behind, ahead] = (await flowGit(root, 'rev-list', '--left-right', '--count', `${target}...HEAD`))
          .split(/\s+/)
          .map(Number);
        Object.assign(result, { behind, ahead });
      } catch (error) {
        result.error = error.message;
      }
    }
    const record = service.lifecycleRuns?.[flow.issueId];
    const number =
      flow.destination?.pr ||
      workspace?.pr?.number ||
      workspace?.result?.pr?.number ||
      workspace?.pr ||
      record?.work?.pr;
    const merged = mergedDelivery(flow);
    if (merged && !refresh) {
      result.pr = { ...merged, number: merged.pr };
    } else if (Number.isSafeInteger(number) || workspace?.branch) {
      await observePR(flow, number, workspace?.branch, refresh);
      Object.assign(result, remote.get(flow.issueId)?.value || {});
    }
    return result;
  }
  async function observePR(flow, number, branch, refresh) {
    const configPath = join(service.root, '.issues/issue-delivery-config.json');
    if (!existsSync(configPath)) return;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const path = join(service.root, '.issues/store-runtime/github-observations', digest(flow.issueId) + '.json');
    let cached = remote.get(flow.issueId);
    if (!cached) {
      try {
        cached = readJson(path);
      } catch {
        /* Missing observations are fetched once. */
      }
    }
    const identity = JSON.stringify([config.repository, number || branch]);
    if (
      cached?.identity !== identity &&
      !(number && cached?.repository === config.repository && cached?.value?.pr?.number === number)
    )
      cached = null;
    if (cached) remote.set(flow.issueId, cached);
    else remote.delete(flow.issueId);
    if (cached?.pending) await cached.promise;
    else if (refresh || !cached) await refreshPR(flow, number, branch, cached, { config, path, identity });
  }
  function refreshPR(flow, number, branch, previous, { config, path, identity }) {
    const cache = { identity, repository: config.repository, pending: true, value: previous?.value || {} };
    remote.set(flow.issueId, cache);
    cache.promise = Promise.resolve()
      .then(async () => {
        const provider = options.provider || new StrategyProvider(service.root, config);
        const pr = await lookupFlowPR(provider, branch, number);
        if (!pr) {
          cache.value = { pr: null, remoteObservedAt: new Date().toISOString() };
          return;
        }
        cache.value = observedPRValue(service.root, config.repository, pr);
      })
      .catch((error) => {
        cache.value = { ...cache.value, remoteError: error.message };
      })
      .finally(() => {
        cache.pending = false;
        cache.value.remoteAttemptedAt = new Date().toISOString();
        mkdirSync(join(service.root, '.issues/store-runtime/github-observations'), { recursive: true });
        writeJson(path, { identity, repository: config.repository, value: cache.value });
      });
    return cache.promise;
  }
  return { observe };
}
function observedPRValue(root, repository, pr) {
  const head = pr.head?.sha;
  observePRReview(root, repository, pr.number, pr.reviewDecision, head);
  return {
    pr: { ...flowPRLink(pr), title: pr.title, head, revision: pr.merge_commit_sha },
    remoteObservedAt: new Date().toISOString(),
  };
}

async function observeStartingBranch(root, flow, result) {
  if (!result.worktreeExists) return;
  const readGit = (...args) => flowGit(root, ...args);
  const upstream = await startingBranchUpstream(flow, readGit);
  const revision = await readGit('rev-parse', '--verify', upstream.tracking + '^{commit}');
  const behind = await readGit('rev-list', '--count', `${result.head}..${revision}`);
  Object.assign(result, { startingBranchRevision: revision, startingBranchBehind: Number(behind) });
}
async function resolveTarget(root, target) {
  const local = await flowGit(root, 'rev-parse', '--verify', `refs/heads/${target.branch}`).catch(() => null);
  const remote = await flowGit(root, 'rev-parse', '--verify', `refs/remotes/${target.remote}/${target.branch}`).catch(
    () => null
  );
  if (!local && !remote)
    throw Error(
      `Target ${target.branch} is unavailable. Fetch it with Git or edit the project delivery configuration.`
    );
  return { revision: remote || local, localRevision: local };
}

function observePendingMerge(checkout, result) {
  try {
    result.merge = pendingIssueMerge(checkout);
  } catch (error) {
    result.error = error.message;
  }
}
