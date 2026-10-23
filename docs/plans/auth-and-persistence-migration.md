# Authentication and persistence migration

Status: agreed scope consolidated for plan review, 2026-10-22. Implementation has
not started. This plan does not launch workers, grant roles, reset databases, or
deploy services.

## Outcome and issue boundaries

Replace Keycloak with Better Auth first, using Drizzle for authentication storage.
Then replace the remaining Prisma persistence with Drizzle. Keep PostgreSQL and
the application’s domain behavior, subject to the explicit access and deletion
changes below. Favor direct, typed queries and clear server boundaries over a new
generic persistence framework.

| Issue                     | Responsibility                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `20261022T210246343-adc3` | Better Auth, identity/session integration, app-native authentication screens, email, and authenticated application behavior |
| `20261022T212703756-04e0` | Designated beat administrators, trusted grant/revoke command, restricted toggle visibility, and server enforcement          |
| `20261022T205947061-17af` | Replace remaining Prisma repositories, types, tooling, and migrations after the verified auth phase                         |

Group the auth and admin issues into one coherent implementation batch, retaining
separate reports and acceptance. The application ORM migration depends on their
verified integration. Final human taste review can remain pending until the
finished batch is runnable; it does not require stopping at each intermediate
commit.

Related queue work remains separate: inherited compiler failures
(`20261022T163741000-bba3`), architecture assessment (`20261022T205814928-1fdb`),
and Fallow enforcement (`20261022T205030878-caa1`). Reuse their evidence and avoid
conflicting repairs. This plan cancels or launches none of those actions.

## Agreed behavior

| Area             | Contract                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity         | One stable user ID connects Better Auth identity to separate application profile/practice data. Identity fields and admin status have a trusted server-side authority.                                            |
| Signup           | Open self-registration with username, email, password, and confirmation. Username is the initial display name; email stays private.                                                                               |
| Sign-in          | Username or email plus password; remember-me; app-native login, registration, forgot-password, and reset screens using existing styling.                                                                          |
| Email            | Verification initially disabled. Password reset works end-to-end. Prefer AWS SES when straightforward; otherwise use the simplest working delivery setup.                                                         |
| Sessions         | Database-backed cookies and standard library lifetimes; caching initially disabled. Logout revokes the current session; password reset revokes all sessions.                                                      |
| Public use       | Methods, modules, and beats are publicly readable. Anonymous local playback/practice remains available; saving user data requires sign-in.                                                                        |
| Private data     | Progress and performances are accessible only to their user. Server identity determines ownership.                                                                                                                |
| Ordinary authors | Authenticated users edit/delete their own content. Adding/moving children requires destination-parent ownership. Copies of public beats belong in the copier’s own module.                                        |
| Beat admins      | Explicit server-managed designation, granted/revoked through a trusted command by stable user ID. Ordinary signups gain no admin authority. Only designated admins see the toggle.                                |
| Admin boundary   | Admins edit/delete any beat while preserving its author. Method/module ownership and move-destination checks still apply. This grants no private-practice or account-management access.                           |
| Delete           | One confirmation explains content/history loss. Authorized deletion atomically removes the selected content, descendants, and associated history for every affected user. Accounts and unrelated history survive. |
| Beat edits       | Preserve existing saved performances and progress, including best tempo. Records remain unversioned; this work adds no historical regrading or unlimited performance retention.                                   |

The Admin toggle controls UI mode, not authority. Server permission checks apply
to direct requests as well as visible controls. Clear user-specific caches and
ignore stale admin mode on logout, account switching, or revoked designation.

## Data boundary across the two phases

The old application database is empty according to the user. Existing Keycloak
accounts are disposable test accounts. Verify the actual target before applying
changes; these statements are not a live service inventory.

Between phases, method/module/beat content and practice data are explicitly
disposable test fixtures. Maintain fixture provenance and inspect it before the
phase-two rebuild. If non-test domain data appears, stop and revise the plan.

Preserve new Better Auth users, credentials/accounts, sessions, stable IDs, admin
assignments, and auth migration history through phase two. Scope cleanup to the
identified application fixtures/tables. The current shared PostgreSQL volume also
contains Keycloak storage; replacing a schema is not a reason to delete the volume
or unrelated databases. No production reset or deployment is part of this plan.

## 1. Establish the transition in an isolated environment

Start only after the plan is reviewed and an action is manually selected.

- Re-read current source, reports, and relevant worker results. Capture the exact
  starting revision and verification baseline; do not assume earlier diagnostic
  counts or worker status still apply.
- Prove a minimal Better Auth request/session round trip against this repository’s
  installed TanStack Start route and cookie APIs. Choose compatible pinned
  dependencies from official documentation. Resolve compatibility before a wider
  implementation; propose a separate change if a substantial framework upgrade
  is necessary.
- Establish disjoint auth and domain migration ownership, preferably separate
  PostgreSQL schemas. Scope each migration configuration explicitly and exercise
  both tools in a disposable database, including any shadow-database workflow.
- Begin checked-in Drizzle migrations for auth. Keep their journal continuous
  when domain tables join Drizzle later. Prove each tool leaves the other owner’s
  tables and migration history intact.
- Assess SES account/region/sender readiness when selected. The repository has no
  established SES setup; CLI/profile availability does not establish readiness.
  Keep CI reset-email checks repeatable with local delivery capture as needed;
  record live SES delivery separately from captured mail.

Exit evidence: a working auth/session/database integration, explicit migration
ownership and replay proof, and a concrete mail configuration or recorded
fallback. A source/build-only demonstration does not satisfy the runtime proof.

## 2. Deliver Better Auth and designated administrators

Repositories temporarily remain on Prisma; this phase must already enforce the
agreed application behavior.

1. Add Better Auth auth tables and server/client integration. Remove browser
   bearer-token plumbing and use validated server sessions for protected routes,
   APIs, and server functions. Keep auth secrets and database code server-only.
2. Apply the small domain-profile schema change needed now: remove the required
   Keycloak mapping and provision the profile with the trusted Better Auth ID.
   Auth owns identity metadata; retain domain-only profile state such as current
   module. Provision idempotently and recoverably. Different ORM clients do not
   provide a shared transaction; failed profile provisioning must block dependent
   domain operations and be safely retryable.
3. Implement ordinary author, destination-parent, private-practice, and beat-admin
   checks at server boundaries. Add the trusted designation command and restricted
   toggle. Keep original authorship during admin edits. Reject browser-supplied
   role/ownership claims and prove revocation takes effect.
4. Correct copy destination selection so a public beat goes into an owned module;
   provide a clear path to create an owned destination when none exists. Build the
   agreed authentication screens and password-reset delivery using library
   facilities. Use `/prototype` only for a concrete unresolved interaction.
5. Implement the agreed deletion semantics while domain storage still uses
   Prisma. Include performances, their notes, all affected progress, descendant
   content, and current-module/current-method references. Existing performance-note
   foreign keys only null the reference, so deleting performance rows alone is
   insufficient. Keep permission checks and affected domain writes in one
   transaction; return no other user’s private history to an administrator.
6. Preserve performance/progress data on ordinary beat edits. Keep the current
   per-beat/user performance replacement behavior, making writes atomic where
   touched. Report any broader bounded integrity repair before expanding scope.
7. Retire Keycloak runtime code, dependency, token/export scripts, theme, Compose
   service setup, obsolete environment instructions, and documentation references.
   Retire its test database deliberately; preserve the shared PostgreSQL volume
   and surviving application/auth stores.

Exit evidence: the auth/admin verification matrix below passes against real
PostgreSQL and the running app; both issue reports identify the exact candidate
commit and evidence. Review, integration, and human acceptance remain separate.

## 3. Replace remaining Prisma persistence

Begin after the auth/admin result has been reviewed, integrated, and verified by
the coordinator, then a separate ORM action has been manually launched.

1. Verify fixture-only domain data and capture auth-survival assertions without
   exposing secrets. Retain stable identities and recreate domain profiles with
   the same IDs when rebuilding fixtures.
2. Extend the existing Drizzle migration history with the new domain schema and a
   reviewed transition for the disposable Prisma-owned tables. Preserve auth
   tables, rows, roles, sessions, and migration history. Test both a completely
   fresh database and an auth-first database upgraded through this transition.
3. Replace repositories and generated Prisma types with explicit typed queries
   and row/domain mappings. Cover nested notes, hierarchy queries, progress
   upserts, best-tempo updates, latest performances, and deletion semantics.
   Fix bounded atomicity/concurrency defects with regression evidence and scope
   notification; discuss changes to domain behavior separately.
4. Provide one clear server-owned database access boundary and connection
   lifecycle. Replace the nullable client export and Prisma-specific retry logic
   with behavior justified by the selected driver. Keep server-only imports out
   of browser bundles and browser-oriented tests.
5. Remove Prisma packages, generated-client consumers, schema/migration tooling,
   and obsolete configuration. Supply repeatable migrate/fixture commands and
   update CI, codebase navigation, and verification documentation together.

Exit evidence: no active Prisma dependency remains; the complete verification
matrix passes, including existing-account/session/admin survival across phase
two and fresh-schema reconstruction. Record inherited unrelated failures as
failures; coordinate their separate repairs rather than declaring a green gate.

## Verification and completion

Use disposable PostgreSQL fixtures and the actual running browser/API paths.
Mocks alone do not establish persistence or authentication correctness.

| Check           | Required evidence                                                                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication  | Signup; username/email login; reload; remember-me; logout; reset email/link; expired/reused reset rejection; old password rejection and all-session revocation after reset                                                                          |
| Access          | Anonymous public reads/local practice; denied private reads/mutations; owner CRUD; another user denied; designated admin beat edit/delete preserving author; destination checks; forged/missing/expired/revoked sessions; tampered client flags/IDs |
| Admin lifecycle | Trusted grant/revoke; ordinary signup stays ordinary; toggle visible only to designated users; logout/account switching and revocation clear effective UI state                                                                                     |
| Domain behavior | Hierarchy and notes; copy to owned destination; per-user progress/performance; concurrency-safe updates; ordinary edits retain history                                                                                                              |
| Deletion        | Two users’ associated history removed for deleted beat/module/method; descendant notes removed; references cleared; siblings/accounts/unrelated history retained; transaction rollback leaves no partial cleanup                                    |
| Migration       | Both tools scoped in phase one; fresh DB replay; auth-first-to-domain upgrade; unchanged auth identities/roles/sessions; successful sign-in and practice afterward                                                                                  |
| Tooling         | Actual typecheck, app/factory tests, production build, relevant formatting, browser console/network checks, and Fallow output retained with checked revisions                                                                                       |

Before committing or finishing a step, run `npx fallow audit --base <recorded-ref>`
using the pinned tool against the actual candidate. Use the snapshot/staged
wrappers where needed so untracked source is included and unstaged fixes cannot
hide staged findings. Review all output, including inherited findings/warnings;
address reported problems and rerun. An exit code alone is insufficient. If a
finding cannot be addressed within authorized scope, record the blocker rather
than marking the step finished. The separate Fallow issue owns any required
general enforcement changes.

Maintain a concise architecture decision and affected codebase/verification/setup
docs with implementation; keep `AGENTS.md` as the router. Use `/tutorial` for the
finished auth/admin/delete walkthrough and record the human’s actual UX judgment
against the reviewed revision. Human taste review and explicit acceptance gate
closure. Physical MIDI/hardware behavior is outside this migration’s evidence.

## Manual execution and review

Proposed action sequence: bounded compatibility/migration investigation; grouped
auth/admin implementation; independent verification/review; explicit coordinator
integration; application ORM implementation; verification/review/integration;
finished walkthrough and strategic `/retro` for the batch.

Each action needs a separate manual launch. `$factory` may evaluate and recommend;
it does not launch. Workers use isolated worktrees and return commits/evidence;
only the coordinator writes the authoritative queue and registry. Serialize
integration, recheck the combined revision, and retain separate issue acceptance.

Propose human-first integration for the completed auth/access/deletion candidate,
with approval requested once its diff and evidence are ready. Decide the ORM
action’s merge policy during its actual evaluation from scope and evidence. This
plan saves no recommendations or reservations and does not alter registry state.

Next step: review this plan. After approval, manually evaluate the queue to choose
the first bounded action. Current worker results and other queued prerequisites
must be inspected during that evaluation; this document is not their live status.
