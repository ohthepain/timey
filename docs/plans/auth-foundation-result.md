# Authentication foundation candidate and authorized correction

This implements only section 2 items 1–2 of the approved
[auth/persistence plan](auth-and-persistence-migration.md), from commit
`71ac33ab31c57c789d98f4f4946a5ab0428707a3`. The approved plan remains unchanged
(SHA-256 `060bbbe55f89fbd3948b8998e83ff6f4f385c2a15df0c8fea814a05e9610a363`).
It is a local foundation candidate. Application cutover and issue-wide completion
remain pending; no integration, lifecycle advancement or human acceptance is claimed.

The candidate adds checked-in v1 auth migrations, a server-only Better Auth runtime
and Request/Response handler, validated session/profile boundary, optional legacy
Keycloak mapping, and a disposable PostgreSQL/HTTP runner. See
[setup and usage](../../AUTH_SETUP.md) and [ownership rationale](../adr/0002-auth-domain-ownership.md).
The application repositories and current callers remain on Prisma/Keycloak.

The implementation inspected and adapted the actual historical artifacts at
`/private/tmp/timey-auth-85c51-u2d8xI/continuation/` and
`/private/tmp/timey-drizzle-e5ea8c59/paired-zod/`, including runtime, schema,
migration SQL/snapshots and fixture orchestration. The exact approval at
`/private/tmp/timey-drizzle-e5ea8c59/human-candidate-approval.json` covers
Drizzle Kit/ORM 1.0.0-rc.5, application Zod 3.25.76, auth Zod 4.6.7,
`drizzle({ client: pool })`, and the historical conversion precision limitation.
This fresh v1 history has no v0 rows to convert; historical evidence/history is
retained, not transplanted or rebaselined. No dependency-probe table is adopted.

The initial candidate and failures below are retained historical evidence. The
2026-10-25 human receipt authorizes the dependency correction recorded at the end
of this document; it supersedes the earlier application Zod pin, not the plan scope.

## Evidence and unresolved failures

The final worker report is retained at `/private/tmp/timey-foundation-result/REPORT.md`
with the exact candidate commit/tree, changed-file list, commands/exits and final
step/staged audit pointers. Evidence remains outside tracked source. This document
is a handoff for the candidate, not an acceptance record.

The implemented app passed real loopback HTTP/PostgreSQL tests: persisted cookies,
missing/forged/expired/revoked/logout rejection, origin rejection, stable IDs across
app restart, concurrent idempotent profiles, deliberate provisioning failure with
same-cookie retry, and rejection/recovery of a legacy-email collision. Migration
replay, actual disjoint-owner permission denial, Prisma shadow replay and cross-owner
schema/history preservation were exercised. The runner retains raw dumps and
commands in the printed unique `/private/tmp/timey-auth-foundation-*` directory.

Aggregate verification against the original base passed formatting, all 28 factory
tests, typecheck, all 36 application tests and production build, plus strict Fallow.
Final step and index checkpoints must refer to the original base and candidate
snapshot in the retained report. Initial syntax/setup/Fallow failures and the later
passing results remain retained. No exemptions, audit exclusions, weaker gate or
later base were introduced.

The initial candidate full dependency audit **failed**: a fresh scan of the original lockfile
reports 118 affected package entries (5 critical), and this candidate reports 123
(6 critical). The five additional propagated entries are Better Auth, its Drizzle
adapter, Drizzle ORM/Kit and db0. Both scans contain the same underlying direct
advisory URLs. This differs from the older saved 45-entry audit; the current raw
results supersede that count and remain failures. Prerelease approval does not
accept these vulnerabilities. No broad dependency remediation is included here;
adoption/completion affected by this failed audit remains blocked.

The approved historical limitation remains explicit: upgraded v0 journal timestamps
retain milliseconds; fresh v1 replay derives seconds from directory names. The
fixture's fresh-v1 replay passes; it does not assert exact timestamp equality with
an upgraded historical journal.

Build warnings remain, including externalized Prisma/node:sqlite, a missing client
default export and large chunks. Fallow's architecture-boundary and policy-pack
detectors are unconfigured and unmeasured. Its configured changed-file analyses
pass; Python/SQL correctness is supported by the runtime assertions, not claimed
as Fallow coverage.

## Remaining coordinated work and human obligations

- Resolve the failed dependency audit in separately authorized dependency work;
  preserve historical failures and require explicit authorization for further changes.
- Deliver screens/client cutover, password-reset delivery, all application access
  checks, coordinated designated-admin permissions, transactional deletion and
  Keycloak retirement. This slice does not satisfy Implement's issue-wide exit.
- Verify the complete browser/auth/access/admin/delete matrix and combined revision.
  No browser UX, live SES, production deployment or physical MIDI claim is made.
- Obtain human-first candidate integration approval, final UX judgment and explicit
  acceptance. Keep the issue in-progress; only the coordinator owns lifecycle and
  authoritative reports/registry.

## Authorized dependency correction — 2026-10-25

Human receipt `answer-9598f89a-551a-4c5e-85b3-ee1ad63ede0f.json` explicitly approves
shared defu 6.1.4 → 6.1.7, including baseline consumers, and application Zod
3.25.76 → 4.6.7, with bounded compatibility work. The prior progress commit
`ce2c8cfcebf16c71d238481a956bbff84b7115bd` and all failed artifacts remain preserved.
The original comparison base and human-first merge policy remain unchanged.

The updated lock changes only those two shared versions. Auth Zod resolves to the
same root Zod 4.6.7. TanStack/Vinxi packages that declare Zod 3 dependencies receive
separate nested 3.25.76 copies; these remain explicitly unresolved, rather than
forcing an incompatible framework dependency or upgrading the framework.

The follow-up evidence and exact final candidate are retained in
`/private/tmp/timey-foundation-approved-corrections-20261025/REPORT.md`.
It records clean installation, actual resolved paths, command exits, compiled
framework/application checks, real HTTP/PostgreSQL provisioning and migration
preservation, aggregate verification and the strict original-base/index checkpoints.
Clean installation and dependency-tree validation passed. All 15 installed defu
consumers resolve 6.1.7, while application/auth/ORM Zod resolve 4.6.7. The actual
PostgreSQL fixture passed 46 assertions. Browser checks passed 12 compiled
framework/read/validation assertions plus seven automatic-cookie/session assertions;
no application compatibility code changes were needed. MIDI permission denial and
unavailable legacy Keycloak initialization remain recorded browser limitations.

The full dependency audit still exits 1: 44 affected entries, including five critical.
Defu is no longer listed; Zod findings point only to four framework-owned nested
3.25.76 paths. Other dependency findings remain unresolved. No historical failed
scan is erased or represented as a pass.

The earlier matched-runtime follow-up found 45 affected entries in both unchanged
baseline and candidate scans, despite preserved 118/123-entry earlier scans with
the same direct advisory URLs. That differing metadata propagation remains recorded
at `/private/tmp/timey-foundation-dependency-followup/REPORT.md`; its cause was not
established. Current results must be read from the new raw logs, not those old counts.

This correction completes only the selected foundation slice when its affected checks
pass. The issue stays in-progress. Screens/client cutover, reset delivery, application
authorization, coordinated admin permissions, transactional deletion, Keycloak
retirement, integration, final UX judgment and explicit acceptance remain pending.
