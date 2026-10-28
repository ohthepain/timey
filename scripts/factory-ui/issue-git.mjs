import { git } from './common.mjs';

// Read only the selected issue's checkout, never the server's source branch.
export function issueGit(snapshot, issue) {
  const actions = new Map(snapshot.actions.filter((a) => a.issues.includes(issue.id)).map((a) => [a.id, a]));
  const workers = snapshot.runs.filter((r) => r.kind === 'worker' && actions.has(r.actionId) && r.checkout);
  const unfinished = workers.findLast(
    (r) =>
      !['assembled', 'integrated', 'superseded', 'reconciled', 'cancelled'].includes(actions.get(r.actionId).status)
  );
  const checkout = unfinished?.checkout || issue.issueDelivery?.checkout || workers.at(-1)?.checkout;
  if (!checkout) return null;
  try {
    return {
      branch: git(checkout, 'branch', '--show-current') || null,
      revision: git(checkout, 'rev-parse', 'HEAD'),
    };
  } catch {
    return { unavailable: true };
  }
}
