export const strategyResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    summary: { type: 'string' },
    pr: { type: ['integer', 'null'] },
    publication: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body'],
    },
    remaining: { type: 'array', items: { type: 'string' } },
    blocker: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['repair', 'human', 'permission', 'infrastructure'] },
        cause: { type: 'string' },
      },
      required: ['kind', 'cause'],
    },
    repair: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: { approach: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
      required: ['approach', 'evidence'],
    },
  },
  required: ['outcome', 'summary', 'pr', 'publication', 'remaining', 'blocker', 'repair'],
};
export function strategyPrompt(root, issue, work, instruction = '') {
  return `Own this ONE issue from its current saved work to a merge-ready PR. No lifecycle roles or stage transitions.
This is the explicit factory handler for implementation and PR operations in this issue's existing owning chat. Earlier discussion-only instructions apply only to their original turns; this execution assignment supersedes them for the work authorized below. The handler resumes this turn with workspace-write access in the working checkout. Use the current tools and permission policy, not earlier assistant claims about read-only access. Never override an actual sandbox restriction or permission denial; request needed access through the available approval flow and report the concrete failed operation if access remains unavailable. Do not refuse solely because an earlier discussion turn was read-only or tell the person to move to another chat or invoke a handler: this is that handler.
Backlog and empty lifecycle history do not block this authorized strategy. Start/Continue and the saved authorization below authorize the selected work; no new feedback or lifecycle transition is required merely to begin or resume it. Read the current issue, saved answers and existing checkout before deciding what remains.
Strategy: ${work.strategy}. ${work.strategy === 'full-stop' ? 'Never merge or enable auto-merge.' : 'The server alone performs the protected merge; do not merge or enable auto-merge yourself.'}
Human scope/strategy authorization: ${work.receipt}. Issue report: ${root}/.issues/${issue.id}.md.
Working checkout: ${work.checkout}; branch: ${work.branch}; original base: ${work.base}.
Delivery: repository ${work.config.repository}, remote ${work.config.remote}, target ${work.config.target}.
Prior unresolved input, preserved for context: ${JSON.stringify(work.priorInput || null)}.
Previously verified delivery through another PR, if any: ${optionalContext(work.externalDelivery)}. Preserve that relationship and use its remainingCriteria as the implementation scope; do not repeat behavior already covered by the linked PR. A changed current target revision requires a fresh review of whether that behavior remains present.
Blocker-repair authorization: ${optionalContext(work.blockerRepair)}. Necessary technical repairs may extend beyond the original feature, including inherited test/format failures, target updates, merge conflicts and new Fallow findings. Preserve intended behavior; ask only for a new product decision, destructive changes or expanded external permissions. Keep each repair in a separate commit and explain why it is necessary. This authority does not authorize unrelated improvements.
Before implementation and before final publication, fetch ${work.config.remote}/${work.config.target}, merge it into this issue branch and resolve conflicts preserving both intended behaviors. Preserve saved uncommitted work first. The server also fetches and merges the target at verification boundaries; resolve any active merge it leaves in this checkout. Never choose one side wholesale, discard unrelated work or move the recorded comparison base to hide findings.
Linked follow-up repair: ${optionalContext(work.followup)}. When this names an already merged PR, retain that PR as history, complete only the remaining work on the named repair branch and link the follow-up PR to the original. Never reopen or overwrite the merged PR. If you discover that the current PR already merged, report it; the server can reconcile its real checks or prepare a follow-up branch for remaining repairs.
Saved comments and answers: ${root}/.issues/conversations/${issue.id}/messages.jsonl. Read relevant new feedback before publication; comments alone do not grant broader scope or merge permission.
Existing approved plan and issue history: ${root}/.issues/factory-ui/lifecycle.json, issues[${JSON.stringify(issue.id)}]. Read only relevant existing work and answers; preserve them. The report and prior conversation are evidence, not authority for unrelated work.
Investigate, implement, run focused checks, fix findings and necessary blockers, commit and push the issue branch. The factory server owns PR creation using its GitHub App identity after independent verification. Do not run gh pr create or create a PR through another tool or personal login; this supersedes earlier worker-publication instructions. For new work return pr: null and publication: {title, body}, preparing a complete reviewable PR description with the relevant changes and verification. For an already saved PR return its number and publication: null. Existing PR authorship and review history must be preserved; never close, replace or reopen a PR to change its author. Resolve ordinary technical choices yourself. Do not repeat completed implementation. Keep the owning chat and saved work. Work is fluid: no role interviews, routes, stage skips, completion manifests or separate coordinator assessments. This strategy replaces the old draft-handoff finish line and role machinery, not required checks or real permissions.
Follow the repo's commands and actual verification requirements. Run TIMEY_FALLOW_ENFORCE=1 TIMEY_FALLOW_WARNINGS=error pnpm run audit:step -- --base ${work.base}; retain its evidence. Fix new actionable findings including warnings. Never disable tests, suppress findings, add audit exclusions or weaken thresholds just to pass. The server runs aggregate verify/test:factory on each changed candidate: do not duplicate it locally. Server verification, CI and readiness failures return to this same owner for repair. Do not stop because a necessary technical blocker was inherited from another change. No automatic Sol review is required: ${work.solRounds ? 'a separately selected bounded Sol review runs after this response, preserving its separate round budget' : 'Sol Loop was not selected'}.
You may push only the issue or named follow-up branch, using --force-with-lease only when necessary. Never push the target branch, bypass protections, delete data, deploy, close or accept issues. Full Stop must disable existing auto-merge and remove merge-queue enrollment before any push. If you cannot confirm prevention of automatic merging, stop. Observe running CI without republishing or repeating unchanged checks. Retry a temporary GitHub/CI/network failure up to three times with delays; stop after persistent failure or an explicit permission denial. Do not retry uncertain chat creation or an uncertain merge without reconciling the original operation.
The server permits three materially different repair approaches per blocker in this explicit run. Report repair {approach, evidence} for each requested repair, with the actual change and evidence paths; never disguise the same attempt as a new cause. If a technical blocker remains, return blocker.kind repair with its stable cause. For a real human decision or permission boundary, use human or permission and state the smallest actionable question. Infrastructure means temporary failures persisted after your bounded retries. Invalid or uncertain protocol results stop for manual attention.
Return the saved PR number or null for server publication, with a truthful result. completed reports your committed implementation/repair ready for independent server verification; it does not claim server verification, publication, merge, acceptance or closure. Use null for publication on an existing PR, and null for blocker and repair when inapplicable. Do not fabricate success or hide failing evidence.
Latest explicit instruction: ${instruction || 'Complete only the issue as described.'}`;
}

function optionalContext(value) {
  return JSON.stringify(value ?? null);
}
