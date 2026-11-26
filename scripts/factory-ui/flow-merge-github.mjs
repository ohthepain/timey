import { setTimeout as delay } from 'node:timers/promises';
import { blockerRepairPolicy, infrastructureFailure } from './strategy-repair.mjs';

function mayRetry(error, attempt, signal) {
  if (signal.aborted) return false;
  return infrastructureFailure(error) && attempt < blockerRepairPolicy.infrastructureRetries;
}

export function mergeGitHubProvider(provider, ctx, options) {
  const wait = options.mergeDelay ?? delay;
  async function retry(operation, request) {
    for (let attempt = 0; ; attempt++) {
      ctx.signal.throwIfAborted();
      try {
        return await request(attempt);
      } catch (error) {
        if (!mayRetry(error, attempt, ctx.signal)) throw error;
        ctx.onProgress(
          `Temporary GitHub failure during ${operation}; retry ${attempt + 1}/${blockerRepairPolicy.infrastructureRetries}: ${error.message}\n`,
          true
        );
        await wait(1000 * 2 ** attempt, undefined, {
          signal: ctx.signal,
        });
      }
    }
  }
  const observed = Object.create(provider);
  for (const method of ['findIssueBranchPR', 'inspect', 'ready', 'gh']) {
    observed[method] = (...args) => retry(method, () => provider[method](...args));
  }
  observed.merge = (number, head, observePR, settings) =>
    retry('merge', async (attempt) => {
      if (attempt) {
        const actual = await observePR();
        if (actual?.merged_at) return (await provider.ready(actual, actual.head.ref, head)).merge;
      }
      return provider.merge(number, head, settings);
    });
  return observed;
}

export async function inspectMergeOutcome(observePR, error) {
  try {
    return await observePR();
  } catch (inspectionError) {
    error.message += ' Merge outcome could not be checked: ' + inspectionError.message;
    throw error;
  }
}
