import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnvironment } from './common.mjs';
import { StrategyProvider } from './strategy-provider.mjs';

const execute = promisify(execFile);
export async function flowGit(root, ...args) {
  const { stdout } = await execute('git', ['-C', root, ...args], {
    env: cleanEnvironment(),
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
  async function observe(flow) {
    const workspace = flowWorkspace(service, flow);
    const checkout = workspace?.checkout;
    const root = checkout && existsSync(checkout) ? checkout : service.root;
    const result = {
      observedAt: new Date().toISOString(),
      worktreeExists: checkout ? existsSync(checkout) : null,
      targetBranch: flow.target.branch,
      pr: null,
    };
    const queries = await Promise.allSettled([
      flowGit(root, 'branch', '--show-current'),
      flowGit(root, 'rev-parse', 'HEAD'),
      flowGit(root, 'status', '--porcelain', '--untracked-files=normal'),
      resolveTarget(service.root, flow.target),
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
    const failures = queries.filter((entry) => entry.status === 'rejected');
    if (failures.length) result.error = failures.map((entry) => entry.reason.message).join('\n');
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
    const number = workspace?.pr?.number || workspace?.result?.pr?.number || workspace?.pr || record?.work?.pr;
    if (Number.isSafeInteger(number) || workspace?.branch) {
      const cached = remote.get(flow.issueId);
      if (!cached?.pending && (!cached || Date.now() - cached.checkedAt > 15000))
        refreshPR(flow, number, workspace?.branch, cached);
      Object.assign(result, remote.get(flow.issueId)?.value || {});
    }
    return result;
  }
  function refreshPR(flow, number, branch, previous) {
    const cache = { checkedAt: Date.now(), pending: true, value: previous?.value || {} };
    remote.set(flow.issueId, cache);
    Promise.resolve()
      .then(async () => {
        const configPath = join(service.root, '.issues/issue-delivery-config.json');
        if (!existsSync(configPath)) return;
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const provider = options.provider || new StrategyProvider(service.root, config);
        const pr = Number.isSafeInteger(number)
          ? await provider.inspect(number)
          : await provider.findByBranch(branch, config.target);
        if (!pr) {
          cache.value = { pr: null, remoteObservedAt: new Date().toISOString() };
          return;
        }
        if (branch && pr.head?.ref !== branch) throw Error('The linked PR source branch changed.');
        if (pr.base?.ref !== flow.target.branch || pr.base?.repo?.full_name !== config.repository)
          throw Error('The linked PR target or repository changed.');
        cache.value = {
          pr: { number: pr.number, url: pr.html_url, state: pr.state, mergedAt: pr.merged_at, head: pr.head?.sha },
          remoteObservedAt: new Date().toISOString(),
        };
      })
      .catch((error) => {
        cache.value = { ...cache.value, remoteError: error.message };
      })
      .finally(() => {
        cache.pending = false;
      });
  }
  return { observe };
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
