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
requires GitHub strict required checks, including enforcement for administrators.
GitHub [strict required checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) must enforce current-target freshness; local reads and locks cannot replace
that protection. No admin bypass, default-branch push or automatic queue enrollment
is allowed. Missing enforcement blocks merge. This refines ADR 0004's production
merge restriction for the explicitly selected strategy path; the legacy delivery
adapter retains its existing refusal. No existing issue receives this merge grant.

Sol Loop is explicitly off, one round, or up to three rounds. One available Sol
reviewer reviews the scoped candidate; the owning chat makes minimal in-scope
fixes. Missing Sol, exhausted budget or unresolved findings stop without inventing
approval, substituting a model, expanding scope or adding reviewers.

The strategy semantics are adapted from t3dotgg/tstack at
[`1085050f3baed1ac724caa4a8166145fb2ac88af`](https://github.com/t3dotgg/tstack/tree/1085050f3baed1ac724caa4a8166145fb2ac88af/skills).
Unlike upstream, Sol review is optional and the server owns aggregate checks and
merge enforcement. These are local adapters, not globally installed skills.
