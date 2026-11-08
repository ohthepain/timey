# Issue strategies replace lifecycle execution roles

The user selected Full Stop (merge-ready PR) and Full Send (merged PR), with Sol
Loop optional for either. Full Stop supersedes ADR 0005's draft-only finish line
for work explicitly started through the strategy controls. Neither strategy grants
deployment, data deletion, unrelated changes, human acceptance or issue closure.
Existing reports, approvals, contributions, branches and history remain evidence;
starting or refreshing the UI does not migrate or launch them.

Discussion-only restrictions apply to their individual turns. An explicit strategy
Start/Continue resumes the same owning chat with workspace-write access and an
execution assignment that replaces earlier discussion-only instructions for the
authorized scope. The assignment must still respect actual sandbox restrictions
and permission denials. Backlog labels and empty lifecycle history do not require
another handler or fresh feedback before authorized strategy work can begin.

Each issue has one owning work chat and branch. Investigation, implementation,
checks and review are activities within the assignment, not separately planned
roles. Starting records human authorization of the displayed issue scope, linked
plan, delivery destination, strategy and review budget. Existing idle work is
adopted; active or uncertain work is never duplicated. The previous lifecycle is
retained as disabled history.

On 2026-11-02 the user approved [autonomous blocker repair](../plans/autonomous-blocker-repair.md).
Explicit Start/Continue grants necessary technical repairs beyond the initial
feature, including inherited tests/formatting, target merges/conflicts and new
Fallow findings including warnings. Repairs stay on the issue PR in separate
commits, or a linked follow-up PR if the original merged. The server sends failed
verification and readiness evidence back to the same owner and verifies changed
candidates. Three different failed approaches to the same blocker stop the run;
temporary infrastructure failures allow three delayed retries. Actual permission
denials and human decisions stop immediately. Inactive work never revives itself.
Full Stop/Full Send boundaries, protected merging and verified Fixed closure remain.

The scheduler selects by the persisted implementation order, then configured
priority, age and ID for issues not yet in that order. Users can reorder issues
from the implementation queue independent of priority. It does not rank lifecycle
stages. Optional queue discussion remains separate.

Full Stop leaves an open, non-draft, merge-ready PR with green required checks,
review findings addressed, and neither auto-merge nor merge-queue enrollment.
Full Send adds an explicit Merge control after the PR is ready. The server
rechecks GitHub's approving review and required checks for the current head when
the person selects it, then performs the protected exact-head merge and records
the result before updating local `dev`. Local updates proceed only on a clean
`dev` checkout and use fast-forward only; otherwise the merge remains recorded
and the local update is reported as needing attention. The Merge control is
separate from issue closure and cleanup. Its human-input merge check binds to
the current strategy run UUID, verified candidate and target revision. The issue
label used to link stored actions is not a candidate approval identity. Explicit
Continue uses its newly authorized run identity; it never carries candidate-bound
approval from another run.
The adapter requires an active GitHub ruleset with strict required status checks. GitHub must
enforce current-target freshness; local reads and locks cannot replace that rule.
The merging credential must not bypass any applicable CI ruleset. Review rulesets
are evaluated separately: for owner-authored or factory-app-authored PRs, the
factory may use its verified PR-only review bypass. Requested changes still block.
No classic protection is required; if one exists, its review requirement still
applies. Merges use the ordinary exact-head REST endpoint without an admin flag,
default-branch push, auto-merge or queue enrollment.

The factory can authenticate its server-owned GitHub operations as an installed
GitHub App. The project-local `.issues/github-app.json` stores public app ID,
repository and an absolute private-key path; deployed servers may instead use
`TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID`,
`TIMEY_SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY`, and
`TIMEY_SOFTWARE_FACTORY_GITHUB_INSTALL_ID`; the key stays outside the repository.
The server signs a short-lived app JWT, discovers the installation and requests a
token restricted to that repository. Tokens remain in memory, refresh before
expiry, and are passed only to the provider's `gh` subprocesses. Personal Git and
CLI logins remain separate. Strategy workers commit and push their issue branch,
then return a PR title/body and a null PR number. After independent candidate
verification the server creates the non-draft PR using the installed App, checks
its author and exact candidate/target, and retains its number before readiness or
merge. Missing App credentials stop publication without a personal-login fallback.
Every retry discovers matching PRs first to reconcile uncertain creation; a closed
or merged match stops rather than creating a replacement.
Existing saved PRs retain their authorship and history; workers cannot adopt a new
personally authored PR, replace a PR or reopen a closed PR to change its author.
If a saved strategy run was cancelled after its PR was published, Fixed acceptance
reconciles that same PR directly with GitHub before applying the normal acceptance
gates. Recovery requires the configured repository and target, the saved issue
branch, a merge still contained in the current target, and passing PR checks. It
stores a durable delivery receipt and evidence outside the disposable checkout.
The cancelled execution remains cancelled; recovery starts no worker, verification
run, replacement PR or merge, and never accepts or closes the issue by itself.
Pending, failed or mismatched PR evidence continues to block Fixed acceptance.
The legacy draft-handoff adapter retains its existing publication policy.
Worktree providers
use the owning project's credentials, not a worktree-local configuration. Failed
app authentication stops rather than falling back to the personal login.
Temporary connection failures while fetching or reading an authentication response,
including timeouts and malformed JSON, use the strategy's bounded infrastructure
retries. Errors retain only the handshake stage and known failure category; response
bodies, tokens and raw exception messages are never recorded. HTTP authentication
and permission denials still stop immediately.

An issue may also record delivery through another PR as a distinct relationship.
The verifier requires that PR to be merged into the configured repository and
target, that the current target still contains its merge commit, and that its
recorded checks pass. The saved record includes the PR, merge and target revisions,
checks, changed paths, a behavior note citing at least one changed path, and any
requirements that remain outstanding. Partial delivery stays available as context
for implementation, which must focus on the outstanding requirements. Rechecking
compares against the current target and records whether its revision changed, so a
later removal can be reviewed and recorded as remaining work. This does not change
publication ownership, create a duplicate PR, accept the issue, or close it. The
issue remains open for explicit human acceptance.

The review ruleset grants the factory app PR-only bypass. The separate CI ruleset
requires the GitHub Actions `test` check and up-to-date branches, with no factory
app bypass. The owner may retain personal bypass for direct pushes. These grants
do not authorize the factory to merge an issue that was not started as Full Send.
The legacy delivery adapter retains its existing policy.

Sol Loop is explicitly off, one round, or up to three rounds. One available Sol
reviewer reviews the scoped candidate; the owning chat makes minimal in-scope
fixes. Missing Sol, exhausted budget or unresolved findings stop without inventing
approval, substituting a model, expanding scope or adding reviewers.

The strategy semantics are adapted from t3dotgg/tstack at
[`1085050f3baed1ac724caa4a8166145fb2ac88af`](https://github.com/t3dotgg/tstack/tree/1085050f3baed1ac724caa4a8166145fb2ac88af/skills).
Unlike upstream, Sol review is optional and the server owns aggregate checks and
merge enforcement. These are local adapters, not globally installed skills.
