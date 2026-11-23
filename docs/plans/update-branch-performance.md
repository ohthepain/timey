# Update Branch performance

Update Branch took minutes while Git merged in milliseconds. A live request on
an already current branch took 182.31 seconds. The retained preceding updates
also took roughly two to three minutes.

The final five live requests completed at a median of **3.377 seconds**, range
2.863–3.509 seconds, with zero errors. Plain remote fetch-and-merge measured a
median of 1.365 seconds. Each request durably completed its attempt, retained the
fetched commit, and left the source clean at the same HEAD. These already-current
requests measure the button's full response time; executor checks cover actual
source advances and conflicts. See [final live evidence](update-branch-performance.final-live.json).

## Measurements

Run the disposable comparison with:

```sh
RUNS=5 node scripts/branch-update-benchmark.mjs --compare --assert
```

It imports the original Git provider, record store, and owned-operation adapter
from `3549f7e8afbc52bf724448e74a9d2460f1c1962c`. Five alternating runs per version
advance a real source branch, invoke the owned update, and check the resulting
commit, completed attempt, clean checkout and released claim. A separate plain
fetch-and-merge alternates order with the owned operation. Trace2 counts Git
subprocesses and remote metadata operations.

The [local evidence](update-branch-performance.local.json) records a median of
2.552 seconds before and 0.599 seconds after, with ranges of 2.539–2.716 and
0.556–0.677 seconds. Metadata lookups fell from 52 to two, and successful metadata
publications from eight to two. These disposable stores use local transport and
establish work reduction, not GitHub or S3 latency.

Five explicitly approved live button requests then completed successfully, with
unchanged clean source and the fetched commit present. The
[live evidence](update-branch-performance.live.json) records a median of 17.596
seconds, range 16.183–18.703 seconds. Plain remote fetch-and-merge in a disposable
copy had a median of 1.460 seconds, range 1.361–1.994 seconds. The selected issue's
store was initialized before timing. These requests used the earlier
`createCommitOnBranch` transport and are not proof of the final transport below.
The original 182-second request is a single baseline sample. All five measured
requests were already current; disposable executor tests separately cover actual
fast-forwards, merges, saved local edits, conflicts, hooks and interrupted work.

GitHub call timings from a separate diagnostic request attributed roughly five
seconds to the two `createCommitOnBranch` calls. API reference reads took about
0.3–0.5 seconds versus 1.4–1.9 seconds through Git over five read-only comparisons.
The remaining transports and artifact operations also contribute, so eliminating
one measured component cannot remove the entire request time.

The final Git-data transport also completed five approved live requests with zero
errors and unchanged clean source. Its [retained measurements](update-branch-performance.git-data-live.json)
have a median of 16.481 seconds, range 16.227–17.584 seconds;
plain fetch-and-merge has a median of 1.474 seconds. This remains
well above the requested merge-like latency. Separate profiling attributed several
seconds to each durable GitHub metadata publication; artifact I/O contributed
roughly another second. Changing the GitHub write protocol did not remove that
architectural limit.

The operator approved moving Coordination to the existing dedicated PostgreSQL
store. Issue and Artifact destinations remain fixed. The operator also approved cancelling two interrupted ownerless flow saves,
including one uncommitted Close preparation. Both were rejected with their
original requests retained, matching publication claim released, and exact current
flow records verified unchanged. The checked move completed and its matching source redirect and destination
receipt were verified. All 47 catalog entries and existing Issue/Artifact settings
were preserved; no claim or pending operation remained. See the
[cutover proof](update-branch-performance.cutover.json). The original Git store and operation history remain available.
PostgreSQL's sub-millisecond read-only queries are diagnostic evidence, not an
end-to-end Update Branch result.

## Implementation

Admission and completion publish separately as atomic Git metadata transactions.
The callback sees private writes and replay receipts until its conditional update
publishes the batch. No source operation starts before admission is confirmed.
Failure before publication leaves the original claim and records intact.

Read sets retain record values and the exact list prefixes used by the callback.
A competing update to an input or Stop command prevents publication. Disjoint
peer changes can be retained through at most five conditional publication attempts,
without replaying the callback. An uncertain response is reconciled against every
buffered receipt before another publication is attempted.

The final GitHub App transport uploads the prepared metadata tree and commit
through the Git data API, verifies both returned object IDs against local Git,
and updates only the configured metadata ref through `updateRefs`. Its
`beforeOid` condition and `force: false` preserve the existing exact-head guard.
The prepared commit uses UTC dates, so GitHub and local Git retain the same object
identity and later reads avoid fetching the just-published commit. Branch creation,
large batches and non-GitHub remotes retain authenticated Git publication.
See GitHub's [tree API](https://docs.github.com/en/rest/git/trees),
[commit API](https://docs.github.com/en/rest/git/commits), and
[conditional reference updates](https://docs.github.com/en/graphql/reference/git#updaterefs).

Established runtime refreshes read setup, role, ownership and selected display
state from one fresh metadata transaction. Git subprocesses batch blob hashing
and index updates. Default GitHub SSH reads share the existing guarded transport;
custom SSH settings retain their configured behavior.

Fresh acknowledged writes return their canonical input values. Replayed receipts
and subsequent reads still read retained storage. Verified immutable payloads are
shared within one metadata transaction, with a 32 MiB serialized-payload budget,
independent caller values, retry after read failure and expiry for detached
callbacks. This does not cache mutable authority across actions.

Progress checkpoints have at most one save in flight, and completion waits for
that save. Fetch, merge and conflict repair run between the metadata transactions.
Source hooks, conflict limits, ownership and Stop guards remain enforced.

## Verification status

The focused store, runtime, ownership and executor checks pass. The strict step
audit passes with Fallow warnings treated as failures. The wider Flow suite has
two failures that also reproduce on the clean starting revision: copied folder
selection and investigation output ordering. Neither was changed for this repair.

The Git data transport passes local request, object-identity, permission,
stale-head, replay, concurrency and artifact lifetime checks. Its five live requests
passed but remained above the requested latency. The PostgreSQL migration and final end-to-end measurements also passed.

The metadata-operation scope and explicit interrupted-publication cancellation
adapter and consistent standalone list reads passed 92 focused checks. The strict audit passed with warnings treated
as errors using measured V8 coverage from that exact candidate. Reproduce with:

```sh
NODE_V8_COVERAGE=/tmp/timey-branch-pg-final-coverage node --test scripts/store-recovery.check.mjs scripts/store-records.check.mjs scripts/project-stores-flow.check.mjs scripts/store-runtime.check.mjs scripts/store-atomic-flow.check.mjs scripts/store-snapshot-scope.check.mjs
FALLOW_COVERAGE=/tmp/timey-branch-pg-final-coverage FALLOW_COVERAGE_ROOT="$PWD" TIMEY_FALLOW_ENFORCE=1 TIMEY_FALLOW_WARNINGS=error pnpm run audit:step -- --base 3549f7e8afbc52bf724448e74a9d2460f1c1962c
```

The cancellation adapter ran only after explicit operator approval for those two
saved requests. A first migration attempt stopped on GitHub HTTP 403 while list
decoding fanned out fresh artifact-location reads. Standalone list reads now pin
records and their overflow relocation metadata to one fresh snapshot. A behavioral
check changes relocation authority during the list: the list still decodes its
original snapshot and the next list observes the changed authority. The migration
resumes its original operation identity after this repair. The original local server was drained and stopped; its replacement
reported zero active actions, operations, uncertain results, chats or approvals.

## Remaining-cost repair and cache design

Moving Coordination to PostgreSQL reduced the five-run median to 6.924 seconds
([measurements](update-branch-performance.postgres-live.json)). Bounded native JSON
records reduced it modestly again ([measurements](update-branch-performance.postgres-inline-live.json)).
PostgreSQL now keeps records and receipts up to 1 MiB in JSONB; larger values still
use the configured Coordination Artifact store. Existing overflow references and
replayed receipts remain readable and verifiable. Issue and Artifact destinations
were not changed by this storage encoding choice.

A separate instrumented run measured 1.670 seconds of Git work and 3.503 seconds in
admission/completion. It was excluded from reported comparisons. Inspection found
that every selected refresh rewrote and reparsed the full 120 MB project display
snapshot. Authoritative reads were already scoped correctly.

The architecture comparison considered immutable issue fragments behind a small
atomic index and a private SQLite cache. Both bound selected writes to selected
issue bytes. The fragment design was selected because it preserves the existing
staging/rollback mechanism and requires no schema or database handles. SQLite's
automatic old-row reclamation was rejected in exchange for the smaller private
surface. Two independent inherited-model candidates agreed on this choice; a
cross-family judge was unavailable. The grounding review found and reproduced a
cache-repair gap, which the implementation corrected before final verification.

The public snapshot API and its hydrated version-1 shape are unchanged. The private
version-2 index references immutable, SHA-256-verified issue files published before
the index. Unchanged frozen issues retain their fragments and in-memory objects.
Legacy caches convert on their next successful install. Scoped claims, commands,
deletions, draft preservation and failed-install rollback keep their existing
semantics. A full authoritative refresh can repair corrupt/missing cache fragments;
a scoped refresh rejects incomplete cache generations. Deleted issues lose their
fragment directory after confirmed installation. Other unreferenced fragments are
retained local display cache; no automatic garbage collection is added here.

Reproduce the isolated comparison without changing shared records:

```sh
node scripts/snapshot-refresh-benchmark.mjs --project /path/to/project --issue ISSUE_ID --output /tmp/snapshot-results.json
```

The [local cache evidence](update-branch-performance.snapshot-local.json) records
five alternating comparisons using the real project cache. The first candidate
install includes one-time legacy conversion; subsequent selected installs preserve
all unrelated issue values and write a roughly 6 KB index instead of the full
120 MB aggregate. This is a local cache result, separate from the final live HTTP
latency above. The final live measurements ran without profiling instrumentation.
The remaining gap from plain Git includes fresh merged-PR/ownership checks,
evidence retention, durable admission/completion and the resulting UI view.

The final candidate passed 160 focused checks across Git transactions, GitHub
publication, native/overflow records, runtime, owned Flow operations, atomic flow
saves, display scopes/files, deletion, retained evidence and Classic snapshots.
The strict step audit passed with zero introduced findings and warnings treated
as failures. Its measured coverage came from this final candidate:

```sh
NODE_V8_COVERAGE=/tmp/timey-branch-verified-coverage node --test scripts/store-recovery.check.mjs scripts/store-records.check.mjs scripts/project-stores-flow.check.mjs scripts/project-stores.check.mjs scripts/store-runtime.check.mjs scripts/store-atomic-flow.check.mjs scripts/store-snapshot-scope.check.mjs scripts/store-snapshot-files.check.mjs scripts/store-git-transaction.check.mjs scripts/store-git-github.check.mjs scripts/store-deletion.check.mjs scripts/store-deletion-retention.check.mjs scripts/store-deletion-cache.check.mjs scripts/store-classic-snapshot.check.mjs
FALLOW_COVERAGE=/tmp/timey-branch-verified-coverage FALLOW_COVERAGE_ROOT="$PWD" TIMEY_FALLOW_ENFORCE=1 TIMEY_FALLOW_WARNINGS=error pnpm run audit:step -- --base 3549f7e8afbc52bf724448e74a9d2460f1c1962c
```

Final shared readback again confirmed the migrated roles, original issue homes,
unchanged cancelled-publication flows, no claims and no pending operations.
