# Freeze merged issues

After GitHub confirms that an issue's PR merged, its issue and work flow become
read-only. A successful Merge receipt remains a delivery fact even when a later
attempt failed or an older runner invalidated the receipt. An externally observed
merge is retained locally so the lock survives server restarts and GitHub outages.

The controller rejects work starts, retries, route Start/Resume, graph and definition edits,
request changes, issue settings, metadata edits, grouping, and bulk updates for
merged issues. HTTP routes enforce the same rule before mutation. For a linked
PR, editable actions refresh its GitHub state first; an unavailable status blocks
the action. Local issues without a PR or issue branch need no remote lookup.

Viewing history and artifacts, opening the checkout, and stopping existing work
remain available. Reading a merged flow never refreshes its saved block
definitions, invalidates successful attempts, or suggests new branch updates.
Template changes discovered on other issues also preserve the merged history.

Close remains a separate, explicit acceptance operation. Its existing Retro and
Cleanup sequence can finish or retry, and closed issues can be archived. Fixed
acceptance validates the original merged candidate and its retained proof, rather
than demanding new verification of a checkout that has since advanced. GitHub's
merged delivery, current required checks, evidence digests, group proof and human
observations still gate acceptance. Existing opt-in automatic closure retains its
meaning.

Restarting a merged issue will require closing and reopening it. Reopening merged
issues is deferred; this change rejects that operation. Existing reopen behavior
for issues that never merged is unchanged. This supersedes the unrestricted
editing and reopening behavior described in [ADR 0013](0013-explicit-issue-flows.md).

See the [implementation plan](../plans/merged-issue-freeze.md) and
[verification commands](../agents/verification.md).
