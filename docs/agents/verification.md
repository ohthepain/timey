# Verification

## Commands and evidence

For default [draft PR handoff](issue-delivery.md#default-draft-pr-handoff), attempt
relevant checks once per changed candidate and retain failures or unavailable
checks as such. They do not block the handoff or trigger a repair loop. Passing
verification, fixed closure and the explicitly selected verified-delivery route
retain the gates below. A handed-off assignment may contain incomplete code;
never describe that result as verified implementation.

Use pnpm and the checked-in `pnpm-lock.yaml`. `.nvmrc` pins the local runtime;
`package.json` declares supported Node versions and the pnpm version in
`packageManager`. Run `pnpm install --frozen-lockfile` in a clean checkout.

The local issue helpers are a pinned development dependency packaged in
[`vendor/`](../../vendor/README.md). The relative `.agents/skills/issues` link
resolves through that installed package; verification and CI require no personal
skill checkout. Its original human-input protocol and integrity manifest are
unchanged. Install the frozen dependencies before running factory checks.
Symbolic links remain in the exported snapshot and audit scope; their link
metadata is not passed to Prettier, which rejects symbolic-link paths. Changed
regular target files retain their own formatting checks.

| Command                             | What it establishes                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test:browser`             | Headless Chromium interactions against candidate UI assets with disposable data; retained logs and screenshots         |
| `pnpm run test:factory`             | Ledger, live UI/CLI boundaries, verifier dispatch/isolation, and audit-result checks using disposable Git repositories |
| `pnpm run typecheck`                | TypeScript compiler result; report existing failures explicitly                                                        |
| `pnpm test`                         | Mock-backed Vitest behavior; recorder CSVs and backups use per-test temporary directories                              |
| `pnpm run build`                    | Production compilation, not runtime or device behavior                                                                 |
| `pnpm run audit:diff -- --base REF` | Fallow audit on changed files in an exported working snapshot (same new-only gate as other checkpoints)                |
| `pnpm run audit:step -- --base REF` | Required audit before declaring an implementation step complete, even without a commit                                 |
| `pnpm run audit:staged`             | Exact index snapshot audit; unstaged fixes cannot hide staged findings                                                 |
| `pnpm run verify -- --base REF`     | Changed-file formatting, factory checks, types, tests, build, and Fallow; runs all and fails if any fails              |
| `pnpm run format-check`             | Repository-wide formatting, including inherited drift                                                                  |

Recorder tests create a unique directory under the system temporary directory for
each test and remove it in teardown, including after assertion failures. Replay
inputs are self-contained; individual replay tests do not depend on earlier tests
or root CSV files. Existing root CSVs are never test cleanup targets.

`verify` exports source into a disposable local clone, shares installed dependencies
only when lockfiles match, and deletes the clone afterward. Each command prints
START, streams output while it runs, and emits a periodic running message during
silence. Per-command logs are readable before completion; summaries retain the
original pass/fail and separate audit-channel assessment. Evidence stays under
`.issues/evidence/` with a JSON summary and per-command logs. Preserve relevant
results in the tracked effort plan before a fresh-worktree handoff. Reports identify
base and snapshot mode; a failed or unavailable check remains a failure/blocker.
The aggregate verifier invokes `pnpm run test:factory` inside that export so its
factory coverage follows the package entry point. A factory failure fails the
aggregate result while the other required checks still run and report separately.

Install the checked-in staged Fallow hook with `pnpm run hooks:install`. It refuses
to replace another hooks directory. It runs the audit on the index snapshot before
commit; it does not imply all tests passed. Run relevant checks as well. When the
caller does not have node on `PATH` (GUI Git clients do not load nvm), the hook
adds the `.nvmrc` Node bin, then Homebrew, and runs the staged audit with that
node. Fallow is pinned to 3.35.0. Checkpoint paths invoke the installed binary,
`fallow audit --base <resolved-commit> --format json`, in the exported snapshot,
using the existing local dependency and `.fallowrc.json`
`audit.gate: new-only`. The helper passes one Fallow `PATH` derived from the Git changed-file list (a single
file, their common directory prefix, or `.` when changes span unrelated roots) so
reported findings stay scoped to the diff instead of defaulting to the whole tree. Fallow may still build a project graph for import
resolution; the verdict uses only **introduced** findings in those changed files.
Inherited issues there do not block. They never use the always-successful
`review` mode or download another binary. Each changed file is analyzed in full;
line-only diff filtering must not hide introduced findings elsewhere in those
files. For a stricter manual check (all findings in changed files), run Fallow
with `--gate all` yourself.
An empty diff is not evidence that new uncommitted files were audited: the snapshot
helper stages its exported files before computing the diff. Sources, index, and
queue of the original checkout are not modified by verification.

For an independently empty exported index diff against the resolved base, the
pinned CLI's compact audit may omit analysis diagnostics. The verifier supplies
that Git-derived scope to the validator; a zero changed-file count reported by
Fallow alone never establishes emptiness. The result records `scope: "empty"`
and an `empty-source-diff` limitation, without claiming unrelated analysis passed.
Process success, pinned JSON/schema, zero findings, pass verdict and the all gate
are still required; warnings, degraded or malformed diagnostics and contradictory
scope fail. Every nonempty snapshot still requires analysis diagnostics, including
untracked additions and deletions. Callers without independently verified scope
retain strict validation and cannot infer empty scope from a saved tool report.

### Commit and step-completion checkpoints

Before a commit, the pre-commit hook runs `pnpm run audit:staged`, which exports
the staged snapshot for verification bookkeeping. **Fallow is skipped by default**
so commits and CI `verify` are not blocked by audit findings. Set
`TIMEY_FALLOW_ENFORCE=1` when you want the pinned Fallow audit to fail the hook,
`audit:step`, or full `verify`. Before declaring an implementation step complete,
including an uncommitted step, run `pnpm run audit:step -- --base <step-start-commit>`.
Use the recorded starting revision, not the new HEAD after committing (which could
hide that step's changes). Full `verify -- --base REF` still runs types, tests,
build, and factory checks; only Fallow enforcement is opt-in. A successful audit
does not establish type/build/device success.

A checkpoint fails on a nonzero Fallow process exit, a `fail` or `error` audit
verdict, warning text on stderr, degraded analysis, missing/unsupported JSON, or a
mismatched gate. A `warn` verdict with exit zero passes (introduced warn-severity
findings are reported in evidence but do not block commits).
Inspect and fix findings, then rerun. Do not suppress warnings, add exclusions,
weaken thresholds, or select a later base to make the checkpoint green. Findings
outside the authorized scope remain explicit blockers for a human decision;
record the failed evidence and say the step is incomplete.

Summary evidence records the full resolved base, source HEAD, exported Git tree,
changed files, checkpoint kind, actual command, raw log/JSON, reasons and pass/fail.
Recheck evidence after any relevant source/index change. An empty scope is recorded
as empty, not proof that unrelated code was audited. The two unconfigured-detector
diagnostics (architecture boundaries and policy rule packs) are retained as
unmeasured coverage, not counted as successful checks; configuring those detectors
is separate architecture work. Other diagnostics fail closed. The audit covers
configured analyses in changed files, not every unchanged file in the repository.

Repository-local Git environment variables are preserved only for reading the
source index; child clone/Git/check processes receive a clean repository context.
This supports hooks and alternate indexes without auditing or changing another
repository's index. The checkpoint commands enforce failure when invoked; agent
completion still depends on following this guide and reviewing current evidence.
There is no global chat-completion interceptor.

The original baseline passed 10 Vitest tests and the production build in a
disposable checkout. Typechecking failed on existing Prisma-nullability and UI
typing errors; repository formatting reported 13 existing files. These are not
waivers: `verify` still returns failure until repaired. Use the local baseline
issues/evidence to distinguish inherited failures from new ones.

## Hands and eyes

Run `pnpm run dev -- --host 127.0.0.1 --port 3000`, save server logs outside tracked
source, and inspect readiness before opening the app. Use a free port rather than
replacing another server. The home page is the initial smoke path; check actual
rendered controls, browser console/network failures, and navigation. An HTTP 200
or a screenshot alone does not establish hydration or interaction behavior.

Database-backed/authenticated paths require configured local services. Compose
defines Postgres; inspect readiness with `docker compose ps` and logs. The Prisma
datasource needs `DATABASE_URL`; Better Auth needs `AUTH_DATABASE_URL`, `BETTER_AUTH_URL`,
and `BETTER_AUTH_SECRET` (see [AUTH_SETUP.md](../../AUTH_SETUP.md)). Compose uses
`DB_USER`/`DB_PASSWORD`. Use supplied local configuration, never print secrets or
reset persistent volumes as a recovery step. Document unavailable credentials or
services instead of substituting mock-backed evidence for real integration.

Use disposable fixtures for writes. A prototype is labeled simulated evidence
unless it uses the real integration. Tutorial navigation is not a verification
verdict. Mocked MIDI cannot establish acoustic or physical-device timing.

## Authentication foundation

Run `pnpm run test:auth` for the actual app HTTP/session and disposable PostgreSQL
proof; see [setup and coverage](../../AUTH_SETUP.md). This creates its own cluster,
owners and databases under a unique temporary evidence directory and retains
commands, assertions and dumps. Existing Compose databases are not targets.
Database-session acceptance and profile recovery are exercised independently of
designated-admin authorization and other pending cutover work.

Run `pnpm run test:auth -- --browser` for the separate app-native `/auth/` screen
slice against that uniquely isolated PostgreSQL cluster and local SMTP capture.
This uses actual signup/login/reset forms in two browser sessions, validates
remember-me/reload/logout cookies and password-reset delivery, expiry, reuse,
old-password rejection and all-session revocation. It retains screenshots,
console/network output, assertions and command exits under the fixture directory.
See [setup](../../AUTH_SETUP.md) for browser prerequisites and partial-rollout
limits. Screen success does not establish domain authorization, coordinated admin
work, deletion behavior, human UX approval or live SES delivery.

The verifier links each declared workspace's installed dependency directory into
the exported snapshot, preserving workspace dependency resolution without changing source
or audit gates. Both application and auth use the approved Zod 4 pin; older framework
packages retain their declared nested dependencies. Use matching `pnpm install --frozen-lockfile` dependencies before verification.

## Human checks

Each issue can have `human_checks` in YAML, separate from `state`/`triage_role`:

```yaml
human_checks:
  - id: midi-device
    kind: evidence
    instructions: 'Perform the recorded MIDI timing scenario on the named device.'
    status: pending
    blocks: dependent-work
    revision: 'commit being checked'
    result: null
  - id: final-experience
    kind: judgment
    instructions: 'Judge the integrated workflow against the agreed outcome.'
    status: pending
    blocks: closure
    revision: 'commit being checked'
    result: null
```

Allowed kinds are `evidence`/`judgment`; statuses are `pending`/`passed`/`failed`.
Record the human's actual result and relevant revision. A code change invalidates
affected evidence. Check scope before declaring older evidence still applicable.
Pending checks can coexist with commits, but block dependent work or closure as
specified. Final acceptance is separate, explicit, and as late as possible.

## Private practice slice

Run `pnpm run test:auth -- --practice` for real server-function and rendered
transport checks with two users in uniquely disposable PostgreSQL. It reuses the
foundation fixture infrastructure without rerunning the completed foundation and
screen investigations. Inspect `practice-assertions.json`, `practice-commands.json`,
application logs and `output/playwright/` in the printed absolute directory.
Rejections must correspond to real server requests; JavaScript/import failures
are test failures, not proof of authentication rejection. Retain SQL before/after
snapshots for rollback and unrelated-history checks. Report expected rejection statuses, unrelated MIDI diagnostics and unexpected errors
separately. See [partial cutover boundaries](../../AUTH_SETUP.md#private-practice-verification).
Content authorization, designated Admin behavior, content deletion, hardware timing
and final human judgment remain separate obligations.

## Method/module write slice

Run `pnpm run test:auth -- --content` for real server-function/API requests and
rendered existing creation/edit controls with two users in uniquely disposable
PostgreSQL. Retain `content-commands.json`, `content-assertions.json`, SQL logs,
application logs and `output/playwright/` in the printed directory. The fixture
asserts actual rejection response statuses and unchanged rows, trusted authors,
owner edits/moves, destination-owner checks, forged fields/cookies, expired and
revoked sessions, profile failure/retry, concurrent ownership changes, public reads,
rendered permission errors and account switching. Browser/import failures fail the
proof. Run the separate `--practice` regression; completed foundation/screen
investigations need not repeat. See [setup and explicit legacy boundaries](../../AUTH_SETUP.md#methodmodule-write-verification).
Deletion, beat/admin permissions, retirement, integration, human UX judgment and
acceptance remain outside this slice.

## Beat creation/copy slice

Run `pnpm run test:auth -- --beats`, then the separate `--content` and `--practice`
regressions. The new proof covers owner creation, public-source copy into an owned
module, no-destination recovery, forged fields and sessions, expired/revoked sessions,
profile failure/retry, account switching, concurrent destination ownership changes,
nested-write rollback and source/history preservation. Retain the printed directory's
`beat-commands.json`, `beat-assertions.json`, SQL logs and `output/playwright/`.
Expected HTTP rejections must be real requests; browser/import failures fail the check.
See [partial cutover inventory](../../AUTH_SETUP.md#beat-creation-and-copy-verification).
Existing-beat editing, deletion, Admin enforcement, retirement and human judgment remain separate.

## Existing-beat editing slice

Run `pnpm run test:auth -- --edit-beats` for real server-function/API and rendered
editing checks in uniquely disposable PostgreSQL with two users. Run `--beats`,
`--content` and `--practice` separately as regressions. Retain the printed absolute
directory's `beat-edit-commands.json`, `beat-edit-assertions.json`, SQL logs,
application logs and `output/playwright/`. The fixture checks author edits/moves,
non-owner/unowned-destination denials, immutable authorship, strict forged-field
rejection, missing/expired/revoked/forged sessions, profile failure/retry, rendered
errors and account-switch draft clearing. Concurrent author, destination-owner
and current-parent changes must not bypass checks. Deliberate note-write failure
must roll back the beat update and note replacement. Both users' history and
unrelated content must survive. Browser/import failures fail this proof.
See [inventory and limits](../../AUTH_SETUP.md#existing-beat-editing-verification).
The missing designated-admin exception, deletion, retirement, integration and
final human judgment remain separate obligations.

## Ordinary-author deletion verification

Run `pnpm run test:auth -- --delete-content`, followed by `--edit-beats`, `--beats`,
`--content` and `--practice`. Retain the printed absolute directory's
`deletion-assertions.json`, `deletion-commands.json`, SQL logs, application logs and
`output/playwright/`. The proof uses two users, actual compiled server-function/API
requests and rendered confirmation/cancellation, refresh and account-switch paths.
It covers strict ownership/session fields, both users' history, descendants,
reference clearing, preserved auth/unrelated records, concurrent changes and
rollback. Browser/import failures fail the check and never count as rejections.
See [deletion semantics and lock tradeoff](../../AUTH_SETUP.md#ordinary-author-deletion-verification).
Designated-admin enforcement, retirement, integration and human judgment remain separate.

## Workflow compatibility

Run `pnpm run test:workflow` while changing issue decisions or evidence freshness.
This shared suite uses disposable queues, the actual decision handler and installed
human-input guard. Its fixture also supplies delivery tests. Full `test:factory`
and `verify` include it; use the focused command during editing before final checks.

Exercise all supported result formats: retained delivery receipts, completed stage
history and older prose-only commit records. For each, acceptance must survive an
unrelated commit, branch switch, dirty checkout, another issue's activity and an
unrelated coordinator lock. Acceptance retains the original result revision and
explicitly records that verification was not rerun. No mutation accepts by itself.
Pair these cases with selected-report freshness, same-issue work and pending/failed
observations. For formats with retained proof, changed or missing proof must block
with its path. Prose-only records preserve their limited evidence; never fabricate
missing historical tests. Keep the matrix current when adding a record format.

Review gate meaning with [review standards](../../CODING_STANDARDS.md), including
whether the tests assert the intended policy. Queue-wide freshness is not a default
for an issue-local decision.

## Persistent issue chat checks

Run `pnpm run test:chat` for the shared issue conversation: disk persistence and
native identity reuse, issue separation, bounded history and full retrospective
context, comments during active work, idempotent transport retries, response
failures, current-question routing, revision checkpoints and DOM draft/focus safety.
The aggregate factory suite includes these checks. Use real browser/provider
smoke evidence separately from protocol fixtures; a mocked response proves no
provider availability. Existing lifecycle and integration tests still own worker
checkout isolation, review independence and actual approval/acceptance guards.

## Deployment readiness diagnostics

`node --test scripts/factory-deploy.check.mjs` uses disposable listeners and Git
fixtures. It includes an unsuccessful candidate (HTTP 503) and unsuccessful
recovery (runtime identity mismatch) through the real deployment waits, with the
production timeouts and failed-recovery lock intact. It prints the retained
absolute evidence directory containing receipt, readiness observations and server
log. Separate probes verify transport refusal, runtime HTTP rejection, malformed
JSON, successful readiness, bounded retention and exclusion of response secrets.
These fixtures deploy no live service and do not diagnose a historical timeout
when its original readiness observations were not retained.

## Issue PR delivery

Follow [issue delivery](issue-delivery.md) for contribution assembly, complete-issue
review, publication, recovery and server-enforced merge gates. New delivery uses
one PR per complete issue. Historical records retain their original meaning.

## Issue capture checks

Run `node --test scripts/factory-capture.check.mjs` for disposable reports and real
HTTP capture requests, including mapped routing, skip reasons, preserved original
wording, independent outcomes, collisions, concurrent/replayed submissions, partial
publication recovery, provider/output failures, local guards and zero work launches.
The aggregate factory suite includes these checks.

Run `node scripts/factory-capture-browser.mjs` for actual rendered keyboard/cancel,
polling and draft preservation, provider-error retry, filtered/scrolled list and
one/multiple toast navigation at desktop and narrow widths. It uses the installed
Playwright CLI and a deterministic assessor against a uniquely disposable queue.
The printed evidence directory retains `commands.json`, assertions and
`output/playwright/` logs/screenshots. Protocol fixtures establish no model access.
Run `node scripts/factory-capture-provider.mjs` separately to check the real
configured provider with synthetic single-bug/numbered-step and distinct-feature
requests. It retains generated reports/results in the printed temporary directory,
uses the existing login/model and fails closed for unsupported configuration.
Neither command targets the authoritative queue or starts factory work. Required
full verification and saved-start step/staged checkpoints still apply.

## Execution preflight and recovery

Before any verification command runs, the exporter checks the installed pnpm lock
against the exported lock and requires dependencies for each declared workspace.
It resolves the immutable comparison commit and exported tree in the clone. Full
verification also opens and closes an actual localhost listener before running the
suite, so a sandbox refusal is an immediate environment failure with no claimed
checks. Audit-only checkpoints do not require networking. Preflight never grants
permissions or installs dependencies automatically.

Summaries retain execution phase timestamps and owned command PIDs. Cancellation
stops the runner's own child process group, retains a failed summary and starts no
remaining checks. Concurrent checks for the same checkout and candidate share the
running independent check; conflicting candidates wait instead of starting an
obsolete second run. Existing independent proof reuse still validates exact inputs
and retained file hashes, including dependency lock identities. Cache diagnostics
record a key and hit/miss reason without environment contents.

Planning and review retain hashed input descriptions. A changed-input failure
identifies the changed source, report, action or policy file and assigns recovery
to the coordinator. Approved lifecycle Progress gets one recovery per unchanged
work basis through the existing scope and approval guards. It preserves previous
results; it does not authorize broader work, waive verification or infer missing
human decisions. A superseded failure cannot override later passing verification
for the same assignment or a checked, assembled contribution. Codex transport
receipts record request/reply/wait/finish timing without prompts or credentials;
uncertain creation still requires discovery of the original chat.

## Browser behavior on the combined candidate

Full verification runs `test:browser` near the start, before the factory/type/unit/build
checks. It serves the exported candidate’s actual UI assets with disposable data,
using the pinned Playwright CLI and Chromium, then closes its owned browser session
and listener. Install its browser with `pnpm exec playwright-cli install-browser chromium`
(`--with-deps` in Linux CI). Missing tooling or failed interactions fail verification.
No production issue writes, provider calls, publication or acceptance occur.

Keep repeatable UI scenarios as `scripts/factory-browser-*.mjs`, exporting an async
function that exercises the page and returns passing assertions. Implement adds
the issue’s interactions; Verify executes them again on the combined source. The
legacy sorting pilot’s existing `scripts/factory-queue.check.mjs` registers its
retained browser replay in `scripts/browser-scenarios/queue-sorting.mjs`; missing
sort controls fail that replay rather than skipping it. This migrates its original
14 browser assertions without repeating implementation.

Raw logs, replay sources and screenshots live beside each verification summary,
with content hashes. Required browser proof is part of the exact-tree verification
summary and delivery evidence, including cached evidence validation. Source/tree,
dependency or runner changes invalidate the existing candidate check key; altered
artifacts cannot be reused. Older summaries without browser checks no longer
establish current delivery readiness. An unchanged candidate may reuse intact
exact-input proof; merging changed code requires new interactions. Human usability
judgment and actual provider/hardware evidence remain separate.

## Combined Clarify checks

`node --test scripts/factory-clarify.check.mjs` exercises old state aliases,
preserved active investigations and custom stages, diagnostic authority before
approval, pending answers across commits, retained plan approvals and explicit,
idempotent capture grilling. These are disposable protocol tests, not evidence
of live model availability. Full factory verification includes them.
`factory-browser-clarify.mjs` exercises the candidate's rendered capture switch,
its off default, retained retry choice and navigation to the saved issue through
the standard browser verifier with a disposable API response.

## Verification ownership and output

Implementation workers run focused checks and the saved-base step checkpoint.
The factory server owns the aggregate candidate verification; workers do not
also run the full suite unless their assignment is verification-only. Optional
Fallow enforcement follows project configuration, including in worker prompts.

An unchanged failed candidate retains its failure and immutable command evidence.
Automatic continuation reports that failure without rerunning the suite. Explicit
Retry verification can start another attempt; source, base, dependency, runtime or
environment changes also invalidate retained attempts. Failure reuse never grants
passing proof or bypasses verified-delivery gates. Draft handoff discloses failures.

The aggregate console shows check starts, heartbeats, results and a bounded list
of failure lines. Full stdout/stderr remains in per-command logs. The outer
verification log updates while commands run, and factory activity receives the
same concise progress. Protocol fixtures inject both legacy and coordinator
connections and reject accidental access to the installed model provider.
