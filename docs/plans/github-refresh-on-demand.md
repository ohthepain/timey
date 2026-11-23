# GitHub refresh on demand

This design interview began on 2026-11-23 after the user observed hundreds of
GitHub API requests without visible changes. The user values fewer requests over
keeping displayed GitHub state current to the last second.

## Agreed decisions

The user confirmed these decisions during grilling:

- GitHub state displayed on screen may stay stale until an explicit refresh or
  an operation needs current facts. Remove recurring GitHub reads whose only
  purpose is display freshness.
- A control may appear available based on saved state. When used, the operation
  validates current conditions and can refuse to proceed. A failed attempt
  preserves work and explains the next step.
- Explicitly started operations may repeat necessary GitHub checks with a finite
  timeout. Those checks stop when the operation finishes, fails, pauses, or is
  cancelled. Active ownership and write-safety checks remain required.
- Shared issue and queue synchronization follows the same on-demand policy.
  Changes from another machine can remain unseen until Refresh or an operation
  needs current state.
- Opening views and switching issues reuse saved observations. Missing
  observations, explicit Refresh, and operations that need current facts can
  trigger remote reads. Navigation, tab focus, and browser polling do not
  repeatedly trigger remote reads.
- Explicit Refresh updates the current view in one coordinated pass and shares
  duplicate reads. The queue refreshes its visible data; an issue view refreshes
  the selected issue's remote details. Refresh does not scan every issue's PR.
- Remote details show when they were last checked. A failed refresh retains the
  last successful values, identifies the failure, and offers an explicit retry.
  Failed reads do not appear fresh or restart background retries.

These decisions establish product intent. Verification evidence below records
implementation status separately.

## Confirmation

All seven interview questions are answered. The user confirmed the complete
design and authorized implementation with "lfg" on 2026-11-23.
The decision is retained in [ADR 0024](../adr/0024-refresh-github-state-on-demand.md).

## Existing constraints

[ADR 0020](../adr/0020-freeze-merged-issues.md) already requires editable actions
on linked pull requests to refresh GitHub state before mutation. A failed lookup
blocks the action. It also retains confirmed merges locally.
Operation-time validation fits that rule. Changing passive display refreshes
does not remove those operation guards.

## Request sources found

Before this change, the [Flow observer](../../scripts/factory-ui/flow-observer.mjs) expired
saved PR observations after 15 seconds. A later observation started another
lookup, including for a retained merged flow. Each refresh constructed a new
`StrategyProvider` unless a provider was supplied.

With GitHub App authentication configured, the provider created a new credential
object. Its token cache belonged to that object. A display lookup could therefore
repeat authentication requests before reading the PR. This followed from the
code paths in [the provider](../../scripts/factory-ui/strategy-provider.mjs) and
[GitHub App credentials](../../scripts/factory-ui/github-app.mjs). It is not a
measurement of the user's traffic. Necessary operation reads also need to reuse
valid credentials.

The [request counter](../../scripts/factory-ui/github-call-history.mjs) reads
local telemetry and collects calls across the installation. Refreshing the
counter does not itself call GitHub. The counter does not identify an initiating
operation, so code inspection establishes possible causes rather than attributing
all observed traffic to the selected screen.

Shared store synchronization also performs remote Git reads. Those reads are
distinct from GitHub REST requests counted by the monitor. The on-demand queue
decision covers display synchronization, while active coordination keeps its
safety checks.

## Implementation

The Flow observer retains remote observations locally and refreshes them only
when missing or explicitly requested. Confirmed merge receipts already supply
saved display state. Failed reads preserve the last successful observation.
Credential sessions are shared by project, repository, and credential identity.
Configuration or key-file changes select a new session.

Shared-store GET requests use saved snapshots. Mutation admission remains fresh.
Selected-issue evidence and Classic display hydration reuse their saved load
until an explicit refresh or a new confirmed snapshot. Navigation renders saved
block details without automatic mutation requests. Start and definition updates
retain their server-side checks.

The current view's Refresh requests current remote data. The project Issues tab
forwards that explicit request to its queue frame. The UI reports saved check
times and refresh failures without automatic remote retry.

## Verification evidence

The focused HTTP regression passed using injected GitHub responses. After the
clock advanced by a day, idle Flow, queue, Home, and closure reads did not fetch
GitHub or synchronize the shared store. Explicit Refresh read again. A failed
refresh retained its earlier value across observer recreation, and a later edit
rechecked GitHub and refused a newly merged PR.

Store runtime, shared Flow, merge guards, strategy, Home, and browser refresh
checks passed. The authentication test checks one shared authentication sequence
for concurrent providers, reuse of a valid token, and new authentication after
credentials change. No live GitHub traffic reduction was measured.

The [browser evidence](../../.issues/evidence/flow-browser-5ab25e20-865d-4b23-97aa-2226e63fc021/github-refresh-on-demand.json)
records no automatic block inspections or remote refresh requests during
navigation and idle polling, followed by one explicit refresh. Its screenshots
also verify the subsequently requested inline Pulse panel below Restart server.
The panel stays within the first column, moves New issue down when opened, and
removes its space when hidden.
