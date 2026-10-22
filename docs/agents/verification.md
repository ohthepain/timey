# Verification

## Commands and evidence

Use npm and the checked-in `package-lock.json`. `.nvmrc` pins the local runtime;
`package.json` declares supported Node versions. Run `npm ci` in a clean checkout.

| Command                            | What it establishes                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm run test:factory`             | Ledger invariants and staged-audit isolation using disposable Git repositories                             |
| `npm run typecheck`                | TypeScript compiler result; report existing failures explicitly                                            |
| `npm test`                         | Mock-backed Vitest behavior; before the pilot this writes root CSVs, so use `npm run verify` to isolate it |
| `npm run build`                    | Production compilation, not runtime or device behavior                                                     |
| `npm run audit:diff -- --base REF` | Fallow new-findings gate against an explicit base, using an exported working snapshot                      |
| `npm run audit:staged`             | Exact index snapshot audit; unstaged fixes cannot hide staged findings                                     |
| `npm run verify -- --base REF`     | Changed-file formatting, factory checks, types, tests, build, and Fallow; runs all and fails if any fails  |
| `npm run format-check`             | Repository-wide formatting, including inherited drift                                                      |

`verify` exports source into a disposable local clone, shares installed dependencies
only when lockfiles match, and deletes the clone afterward. Evidence stays under
`.issues/evidence/` with a JSON summary and per-command logs. Preserve relevant
results in the tracked effort plan before a fresh-worktree handoff. Reports identify
base and snapshot mode; a failed or unavailable check remains a failure/blocker.

Install the checked-in staged Fallow hook with `npm run hooks:install`. It refuses
to replace another hooks directory. It runs the audit on the index snapshot before
commit; it does not imply all tests passed. Run relevant checks as well. Fallow is
pinned, and uses `audit --gate new-only`, never the always-successful `review` mode.
An empty diff is not evidence that new uncommitted files were audited: the snapshot
helper stages its exported files before computing the diff. Sources, index, and
queue of the original checkout are not modified by verification.

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
