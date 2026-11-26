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

After closing the issue, select **Reopen** from its issue page. This also works
from Archive. Factory retains the previous delivery and attempts, then prepares
a new implementation cycle with its own branch and pull request. Issue Discuss
opens for the follow-up. **Save feedback** appends the agreed wording to **Your
words**. Select **Start** to authorize the new run.

See the [implementation plan](../plans/merged-issue-freeze.md) and
[verification commands](../agents/verification.md).
