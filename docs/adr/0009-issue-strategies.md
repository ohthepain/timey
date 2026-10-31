# Issue strategies replace lifecycle execution roles

The user selected Full Stop (merge-ready PR) and Full Send (merged PR), with Sol
Loop optional for either. Full Stop supersedes ADR 0005's draft-only finish line
for work explicitly started through the strategy controls. Neither strategy grants
deployment, data deletion, unrelated changes, human acceptance or issue closure.
Existing reports, approvals, contributions, branches and history remain evidence;
starting or refreshing the UI does not migrate or launch them.

Each issue has one owning work chat and branch. Investigation, implementation,
checks and review are activities within the assignment, not separately planned
roles. Starting records human authorization of the displayed issue scope, linked
plan, delivery destination, strategy and review budget. Existing idle work is
adopted; active or uncertain work is never duplicated. Failures stop with evidence
for manual attention. The previous lifecycle is retained as disabled history.

The scheduler selects by configured priority, then oldest eligible issue, then ID.
It does not rank lifecycle stages. Optional queue discussion remains separate.

Full Stop leaves an open, non-draft, merge-ready PR with green required checks,
review findings addressed, and neither auto-merge nor merge-queue enrollment.
Full Send adds a server-owned merge. Its adapter uses an exact-head merge and
requires an active GitHub ruleset with strict required status checks. GitHub must
enforce current-target freshness; local reads and locks cannot replace that rule.
The merging credential must not bypass any applicable CI ruleset. Review rulesets
are evaluated separately: for owner-authored or factory-app-authored PRs, the
factory may use its verified PR-only review bypass. Requested changes still block.
No classic protection is required; if one exists, its review requirement still
applies. Merges use the ordinary exact-head REST endpoint without an admin flag,
default-branch push, auto-merge or queue enrollment.

The factory can authenticate its server-owned GitHub operations as an installed
GitHub App. The project-local `.issues/github-app.json` stores public app ID,
repository and an absolute private-key path; the key stays outside the repository.
The server signs a short-lived app JWT, discovers the installation and requests a
token restricted to that repository. Tokens remain in memory, refresh before
expiry, and are passed only to the provider's `gh` subprocesses. Personal Git and
CLI logins remain separate; worker publication is unchanged. Worktree providers
use the owning project's credentials, not a worktree-local configuration. Failed
app authentication stops rather than falling back to the personal login.

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
