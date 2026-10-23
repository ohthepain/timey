# Verification

## Commands and evidence

Use npm and the checked-in `package-lock.json`. `.nvmrc` pins the local runtime;
`package.json` declares supported Node versions. Run `npm ci` in a clean checkout.

| Command                            | What it establishes                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm run test:factory`             | Ledger, interface, verifier dispatch/isolation, and audit-result checks using disposable Git repositories |
| `npm run typecheck`                | TypeScript compiler result; report existing failures explicitly                                           |
| `npm test`                         | Mock-backed Vitest behavior; recorder CSVs and backups use per-test temporary directories                 |
| `npm run build`                    | Production compilation, not runtime or device behavior                                                    |
| `npm run audit:diff -- --base REF` | Strict Fallow gate for all reported findings in changed files, using an exported working snapshot         |
| `npm run audit:step -- --base REF` | Required audit before declaring an implementation step complete, even without a commit                    |
| `npm run audit:staged`             | Exact index snapshot audit; unstaged fixes cannot hide staged findings                                    |
| `npm run verify -- --base REF`     | Changed-file formatting, factory checks, types, tests, build, and Fallow; runs all and fails if any fails |
| `npm run format-check`             | Repository-wide formatting, including inherited drift                                                     |

Recorder tests create a unique directory under the system temporary directory for
each test and remove it in teardown, including after assertion failures. Replay
inputs are self-contained; individual replay tests do not depend on earlier tests
or root CSV files. Existing root CSVs are never test cleanup targets.

`verify` exports source into a disposable local clone, shares installed dependencies
only when lockfiles match, and deletes the clone afterward. Evidence stays under
`.issues/evidence/` with a JSON summary and per-command logs. Preserve relevant
results in the tracked effort plan before a fresh-worktree handoff. Reports identify
base and snapshot mode; a failed or unavailable check remains a failure/blocker.
The aggregate verifier invokes `npm run test:factory` inside that export so its
factory coverage follows the package entry point. A factory failure fails the
aggregate result while the other required checks still run and report separately.

Install the checked-in staged Fallow hook with `npm run hooks:install`. It refuses
to replace another hooks directory. It runs the audit on the index snapshot before
commit; it does not imply all tests passed. Run relevant checks as well. Fallow is
pinned to 3.35.0. Both checkpoint paths invoke
`npx --no-install --offline fallow audit --base <resolved-commit> --gate all --format json`
in the exported snapshot, using the existing local dependency. They never use the
always-successful `review` mode, download another binary, or waive inherited
findings in changed files. The full changed files are analyzed; line-only diff
filtering must not hide older findings elsewhere in those files.
An empty diff is not evidence that new uncommitted files were audited: the snapshot
helper stages its exported files before computing the diff. Sources, index, and
queue of the original checkout are not modified by verification.

### Commit and step-completion checkpoints

Before a commit, the pre-commit hook audits the exact staged snapshot against
HEAD. Before declaring an implementation step complete, including an uncommitted
step, run `npm run audit:step -- --base <step-start-commit>`. Use the recorded
starting revision, not the new HEAD after committing (which could hide that step's
changes). Full `verify -- --base REF` uses the same strict audit in addition to its
other checks. A successful audit does not establish type/build/device success.

A checkpoint fails on a nonzero process exit, non-pass verdict, reported findings,
warning output, degraded analysis, missing/unsupported JSON, or a mismatched gate.
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

Run `npm run dev -- --host 127.0.0.1 --port 3000`, save server logs outside tracked
source, and inspect readiness before opening the app. Use a free port rather than
replacing another server. The home page is the initial smoke path; check actual
rendered controls, browser console/network failures, and navigation. An HTTP 200
or a screenshot alone does not establish hydration or interaction behavior.

Database-backed/authenticated paths require configured local services. Compose
defines Postgres and Keycloak; inspect readiness with `docker compose ps` and logs.
The Prisma datasource needs `DATABASE_URL`; Compose uses `DB_USER`/`DB_PASSWORD`.
Browser identity settings are `VITE_KEYCLOAK_URL`, `VITE_KEYCLOAK_REALM`, and
`VITE_KEYCLOAK_CLIENT_ID`. Use supplied local configuration, never print secrets or
reset persistent volumes as a recovery step. Document unavailable credentials or
services instead of substituting mock-backed evidence for real integration.

Use disposable fixtures for writes. A prototype is labeled simulated evidence
unless it uses the real integration. Tutorial navigation is not a verification
verdict. Mocked MIDI cannot establish acoustic or physical-device timing.

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
