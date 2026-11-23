# Refresh GitHub state on demand

Display freshness does not justify recurring GitHub requests. Views reuse saved
observations across navigation and restarts. Missing observations and explicit
Refresh can read remote state. Refresh updates the current view and shares
duplicate requests, rather than scanning every issue's PR.

Operations check current facts when needed and can refuse an action whose
displayed availability is stale. Active operations retain bounded checks and
ownership synchronization. This preserves [merged issue
guards](0020-freeze-merged-issues.md) and provider-enforced merge protection.

Shared queue display synchronization follows the same policy. Remote changes can
remain unseen until Refresh or an operation needs current state. Failed refreshes
retain saved values, show their last successful check time, and require explicit
retry. See the [agreed design](../plans/github-refresh-on-demand.md).
