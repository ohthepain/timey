# Issue pull request delivery

Use the shared server operations in `scripts/issue-delivery.mjs` through either
`factory issue-delivery OPERATION ISSUE_ID [INPUT.json]` or the issue UI. Inspection
reads saved state only. Mutations are explicit coordinator operations under the
selected issue's authority; worker completion grants no publication permission.

Configure `.issues/issue-delivery-config.json` with `provider: "github"`, the
explicit `repository` (`owner/name`), `remote: "origin"` and target branch. The
configured repository must match the Git remote. No configuration is inferred
from branch names or supplied by the browser. The production adapter uses `gh`
and the existing Git credential setup. Live access and publication remain guarded
operations. Reading this guide or running fixtures authorizes neither.

The operation sequence is:

1. `assemble`: input `actionId`, `expectedCandidate` and independently reviewed
   `review: {path,sha256}`. Merge the exact completed contribution into the stable
   issue branch in a separate checkout, run independent combined checks against
   the immutable original base, retain evidence, then record `assembled`. Existing
   policies remain intact. A conflict preserves the checkout and lock for explicit
   reconciliation. Never reset, stash or remove an unknown lock to force progress.
2. `ready`: input `manifest` with `plan` hash, `candidate`, complete contributing
   `actions`, `verification` summary paths, `review` evidence and `criteria`.
   Each criterion names the exact corresponding nonempty approved-plan line and
   supplies hashed evidence. Verify, saved-base step and staged summaries must
   cover the exact aggregate tree. Use `additionalVerification: {BASE: [summary paths]}` for each differing immutable contribution base. Unfinished issue actions and custom stages
   block readiness. The reviewer must judge semantic completeness; a JSON shape
   alone cannot establish that the plan has been implemented.
3. `open`: publish only the issue ref at the expected candidate, then discover or
   create its one PR. Intent is retained before each effect. The canonical PR
   identity and operation fingerprint survive restarts. Closed PRs and mismatched
   identity block speculative replacements. `reconcile` discovers uncertain
   effects; an ambiguous result or missing result after uncertainty blocks retries.
4. `refresh` and `merge`: fetch current provider observations. Checks must come
   from trusted provider policy and cover the tested candidate/target/tree.
   Conflicts, unresolved reviews, unknown policy, failed/pending/missing checks,
   stale local evidence and changed refs block merge. Any human-first contributor
   requires human approval of the entire aggregate tuple. UI confirmations are
   expiring and single-use. CLI approvals name `actor: "human"`, operation
   `merge-issue-pr`, `issueId`, and the SHA-256 fingerprint of the full delivery
   request. Preserve the actual person's decision; never synthesize it in chat.
5. `verify`: after confirmed merge recovery, fetch and establish target inclusion
   and merged tree, then independently check the merged revision against the
   immutable original base. Failures remain `merged-unverified`. A successful
   integration receipt permits later guarded delivery bookkeeping and final review.
   It supplies no human judgment, acceptance or closure.

The GitHub production adapter currently fails closed for merge: its merge API has
no expected-target condition. Configuration cannot override this capability.
[ADR 0004](../adr/0004-issue-pr-delivery.md) records the official API evidence.
Deterministic fixtures exercise conditional merging without live provider effects.

New direct target delivery assertions are rejected. Read historical records with
their original limitations; do not manufacture PRs for older results. An assembled
implementation dependency requires `start: {issueId,revision,approval:{path,sha256}}`
and an actual human receipt with operation `start-assembled-work` for that exact
issue/revision. Workers start from that recorded revision; their original base is
never replaced by a later target. Cross-issue consumption is blocked. Grouped
candidates require separately authorized and reviewed allocations before assembly;
copying the whole candidate into multiple issue PRs is rejected.

State is retained in `.issues/issue-deliveries/ISSUE_ID/`, with immutable intent,
result, assembly, completion, observation and integration files and an atomically
replaced current index. Missing/tampered proof blocks with the relevant path.
Both front doors share these operations. Native evaluation/launch remain separate
manual operations and single-issue lifecycle Progress retains its scope boundary.

## Missing settings and stopped checks

The issue coordinator applies an explicit saved target-branch answer before
assembly when project delivery settings are absent. It uses the actual GitHub
origin identity and a matching human answer receipt, retains the receipt hash in
the settings, and never replaces existing settings or infers a target from the
checked-out branch. Older single-question `dev`/`main` answers are recognized only
for that exact repository and issue. Otherwise it asks a concrete target question
in the issue; answering saves the setting and continues the existing operation.

A failed assembly stops with the actual failure and an explicit retry action,
without asking a model to review the same failure again. Retry rejects stale or
duplicate clicks and rechecks current authority. Assembly retains the merged HEAD
before checking it; an unchanged retry checks that HEAD without invoking merge
again. Interrupted older assemblies are recoverable only from the exact worker
commit or exact two-parent merge including the saved base. Changed or dirty source
and conflicts require reconciliation; retries never discard changes or unknown
locks. An actual failed check remains failed. Repair it separately, then retry;
a changed source result must go through normal review rather than being silently
accepted as the old candidate. This mechanism neither publishes nor merges a PR,
and does not repeat historical target integrations.

### Verification handoff

A saved same-issue `verify` task with `merge: none` may automatically bind to the
exact retained issue candidate under its current approved plan. The ledger owns
this metadata update and revalidates plan approval, contribution receipts, clean
branch identity, dependency membership and ancestry before reservation. It records
a `verification-only` purpose with the actual plan receipt; it never fabricates a
human `start-assembled-work` approval. Implementation still requires that separate
exact human approval. A verification task cannot borrow this handoff to write or
deliver code, consume another issue's assembly, or silently use a newer candidate.

Lifecycle Continue performs this handoff before any replan, then starts the saved
verification assignment. The assignment retains its original comparison bases;
its starting candidate is not a replacement comparison base. Failed launch
eligibility is shown as the concrete blocker instead of “Review finished.” Changes
to the saved issue checkout are relevant retry inputs; unrelated queue changes
remain irrelevant. Binding creates no worker/chat/worktree and performs no merge.

### Coordinator completion review

Lifecycle Progress prepares completion records itself after the selected issue's
work has been reconciled. The UI never asks the person to create or upload a
manifest. A read-only coordinator review matches every nonempty approved-plan item
to actual source and supporting project files. The server supplies candidate and
contribution identities, hashes the reviewed files, and passes the resulting
record through the existing `ready` operation. Missing/failed evidence, wrong
bases or trees, unfinished actions and changed scope still block readiness.
Passing tests alone does not establish that the approved feature is complete.

The review is issue-scoped and serializes with existing result recording. A
changed report, plan, contribution or proof cannot silently reuse its approval.
An incomplete review asks only a specific real decision, permission or human
observation; an ordinary technical gap is reported as unfinished work, without an
answer box requesting a file or routine technical bookkeeping. A technical gap
hands its retained findings to one bounded repair-selection attempt under the
approved plan, ahead of another completion review. Saved stops from older servers
expose Continue for that same recovery. The recovery is remembered for the relevant
inputs so unchanged failures cannot create an endless planning loop. Repair
recommendations are saved and dispatched before Commit, preserving the issue
candidate, original bases and completed contributions. Scope decisions still stop
for an actual answer; readiness, publication and merge guards are unchanged.

Opening a PR publishes the issue branch. Existing lifecycle plan consent does not
grant pushes ([operating policy](operating.md#local-ui-transport)). Once readiness
is established, the UI shows the exact repository, issue branch, target and commit
for publication approval. It retains that actual approval and rejects a changed
tuple before publication. The shared durable PR intents still recover partial
publication without duplicate PRs. After opening, the PR link and existing
check/merge controls are shown; no automatic acceptance or closure is inferred.
Manual CLI `ready` input remains supported for compatibility, using the same
validation, but is not a user-facing upload workflow.
A failed publication retry reuses the exact retained human approval when its tuple
and evidence are unchanged; it does not ask for the same permission again. The
provider discovery and immutable intents still determine whether an existing PR
must be reconnected instead of created.
