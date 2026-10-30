# Authentication foundation

This is a partial application cutover in the coordinated authentication/admin migration.
Private progress and recorded performances use validated Better Auth sessions.
Method/module creation and editing also use validated Better Auth sessions.
Beat creation and public-beat copying now also use validated Better Auth sessions.
Existing-beat editing and moves now use validated Better Auth sessions. Ordinary-author deletion now uses the same boundary. The app header uses the Better Auth client for sign-in and sign-out. The `/auth/login`, `/auth/signup`, `/auth/forgot-password`,
`/auth/reset-password` and `/auth/session` screens exercise Better Auth directly.
Use [the approved plan](docs/plans/auth-and-persistence-migration.md)
for the remaining coordinated permissions and retirement work.
Keep unrelated content callers on their existing authentication path until their coordinated authorization cutover.

## Install and configure

Use the Node version in `.nvmrc` and `pnpm install --frozen-lockfile`.
Application and auth now use Zod 4.6.7 under the explicit follow-up approval.
The auth workspace retains the server runtime boundary. Older framework packages
keep their own required Zod 3 dependencies; these are separate, unresolved audit findings.
The approved dependency pins are in the manifests/lock; do not use force, overrides,
or legacy peer resolution to substitute a different combination.

Supply server environment variables through the process environment or an untracked
local environment file. None are `VITE_` variables:

- `AUTH_DATABASE_URL`: PostgreSQL auth owner connection. Owns only `auth` and
  `auth_migrations`, including their tables and migration history.
- `DATABASE_URL`: Drizzle domain connection, explicitly selecting `?schema=domain`
  in a fresh setup. Its distinct owner owns only the domain schema and
  `domain_migrations` history.
  Preserve the existing schema selection on an existing installation; moving it
  is a separate operation, not part of this foundation.
- `BETTER_AUTH_URL`: public application origin, HTTPS except for loopback development.
- `BETTER_AUTH_SECRET`: a generated secret of at least 32 characters, stable across
  application instances/restarts. Do not use the disposable fixture value.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` (a sender email address), `SMTP_SECURE`
  (`true` for implicit TLS, `false` for STARTTLS or loopback capture): required
  server-only reset-mail transport settings. Non-loopback SMTP requires TLS.
- `SMTP_USER` and `SMTP_PASSWORD`: optional, supplied together for authenticated
  SMTP. Never prefix mail credentials with `VITE_` or commit them.

The retained mail investigation did not establish straightforward SES readiness.
Use the approved local SMTP-capture fallback for local/CI verification. The fixture
starts its own loopback capture server and never forwards messages. A deployment
can supply authenticated SMTP (including separately configured SES SMTP), but sender
verification, credentials and live delivery are separate deployment work. This
slice provisions no AWS resources and sends no external email. Missing/invalid
SMTP configuration fails server initialization rather than silently dropping resets.

Deployers provision schema owners and credentials separately. On an already
verified target, connect as the auth migration owner and run:

```sh
psql "$AUTH_DATABASE_URL" -v ON_ERROR_STOP=1 -f auth/schemas.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f domain/schemas.sql
pnpm run auth:migrate
pnpm run domain:migrate
```

`auth/schemas.sql` creates only the two auth-owned schemas under the connected owner;
it grants no roles. The domain owner must have no rights to alter/drop auth objects,
and the auth owner must have no rights to alter/drop domain objects. The fixture
checks these denials. Use separately scoped runtime credentials when deploying;
this work provisions no real roles, databases, AWS resources or external mail.
Never run Drizzle push against an existing installation as setup.

To append an auth schema change, edit `auth/schema.ts`, run `pnpm run auth:generate`,
review the generated SQL/snapshot and check them in together. `auth/drizzle.config.ts`
limits generation to auth and stores history in `auth_migrations.__drizzle_migrations`.
Domain schema changes live in `domain/schema.ts`. Run `pnpm run domain:generate`,
review the SQL, and check it in with `pnpm run domain:migrate`. History is stored
in `domain_migrations.__drizzle_migrations`. Keep auth history continuous. Do not
copy the old disposable experiment's history or dependency-probe table into this foundation.

## Request and session boundary

`/api/auth/$` forwards real Requests/Responses through the installed TanStack Start
1.114 API route integration. Returning the original Response preserves Set-Cookie.
Configuration loads lazily behind the installed framework's `serverOnly` boundary;
secrets and PostgreSQL drivers belong exclusively on the server. Database sessions
use Better Auth's default lifetimes, cookie caching disabled, email/password and
username login, current-session logout and reset-session revocation configuration.
The server-owned Nodemailer callback delivers library-generated reset links. The
browser client uses Better Auth's signup, username/email sign-in, remember-me,
sign-out, reset-request and reset-password facilities. Password confirmation is
checked in the forms; username is the initial display name and email is never
shown on the account screen. Return destinations must be local application paths;
unsafe values fall back to `/auth/session`. Auth routes bypass saved-route
restoration and are not saved, so reset URLs/tokens are not retained there.

This is an explicit partial rollout: the header's Practice account/sign-in link opens
the Better Auth screens and supplies the validated session state for method/module
creation/edit and beat creation/copy controls; the legacy Login/menu remains for deferred content paths.
Private progress and performance server functions call `requireDomainUser` before
accessing records. Strict request schemas reject supplied ownership/token fields.
Browser state gates controls only; it never authorizes a server operation. No admin
authority is added. Public content and anonymous playback/recording remain available.

The practice session control observes Better Auth browser session changes and checks
`/api/session` every five seconds and on window focus outside the auth screens.
Auth screens retain lazy domain-profile provisioning until domain work is requested. Session changes, loss and
profile failures clear cached performances and selected private data. Each browser
private operation also validates identity before and after its request and discards
late results across session generations. Module progress is scoped to the current
identity and replaced when the account changes. A failed persistence operation
leaves local practice available and provides a sign-in/retry message.

Performance replacement retains one saved recording per beat/user, its index and
played-note values. Replacement and explicit recording deletion use one domain
transaction, serialized with a transaction advisory lock per beat/user. Cleanup
removes only performance-owned notes without a content beat link, retaining unrelated
recordings and content notes. There is no historical regrading or tempo snapshot.
Existing best-tempo read/compare/upsert concurrency and the two-write start-beat
operation remain separate integrity follow-up; this slice does not redesign them.

`GET /api/session` returns only the validated user's domain `userId`, with no-store
caching. `requireDomainUser` is also usable inside later server functions: its default
Request comes from the installed `getWebRequest` API. A missing, invalid, expired or
revoked session yields 401. Auth persistence is consulted on every request. Browser
IDs, bearer tokens and email matches cannot supply identity to this path.

Profile provisioning uses that trusted ID as the domain `User` primary key. Existing
domain state is retained on retry; transitional name/email copies are not identity
authority. The legacy nullable unique Keycloak mapping exists only for callers
awaiting cutover. Legacy email collisions fail closed rather than linking accounts;
resolve such disposable fixtures explicitly during the later coordinated cutover.

The auth and domain clients do not share a transaction. A signup may succeed while
profile creation fails. The domain boundary returns 503 and does not return an
identity to dependent domain work. Retry the boundary with the same live cookie
after correcting the domain failure. Concurrent empty-update upserts can race;
only a unique-constraint race with an already-existing identical trusted ID is
recovered. Other failures remain failures. Do not use `/api/auth/get-session` alone
as permission to run domain operations that require a provisioned profile.

## Repeatable verification

Install local PostgreSQL tools (`initdb`, `pg_ctl`, `psql`, `pg_dump`), then run:

```sh
pnpm run test:auth
# Same fixture plus actual rendered screen/cookie/mail checks:
pnpm run test:auth -- --browser
```

For a browser or compiled-server-function check against the same disposable data,
run `pnpm run test:auth -- --pause-for-browser`. After the HTTP/provisioning assertions,
the runner prints the loopback URL and waits for Enter before stopping its processes.
Use the printed target; do not point writes at an existing database.

The runner creates a unique `/private/tmp/timey-auth-foundation-*` cluster and selects
free loopback ports. It creates fixture-only owners and three fresh databases;
it accepts no external database target and never resets a pre-existing database.
It starts the actual app, exercises HTTP cookies/sessions and database persistence,
and stops only its own process group/cluster in `finally`. Do not run concurrent
copies in the same checkout because Vinxi uses a shared build cache.

Evidence stays in the printed directory: command exits/logs, assertion results,
PostgreSQL dumps, migration histories, application log and disposable identity IDs.
Treat the directory as private fixture evidence. Delete it only after retaining
needed evidence; the runner deliberately preserves it. PostgreSQL shared-memory
creation may require command approval beyond file/network sandbox grants.

The proof covers fresh/repeated migration replay and owner isolation, domain shadow
replay preservation, real signup cookies and persisted sessions, invalid/expired/
revoked/logout and foreign-origin rejection, persistence across an app restart,
stable IDs, concurrent provisioning, injected database
failure, same-cookie recovery and legacy-email collision rejection.
Admin permissions, production deployment and live SES remain later checks; deletion has a separate proof below.
The optional `--browser` check requires the Playwright CLI skill wrapper (override
its path with `PWCLI` if needed), installed Chrome and local process/IPC permission.
It uses two isolated browser sessions and the actual forms, not mocked auth or
API-only login/reset. Evidence includes field validation, private account display,
username/email login, persistent/session cookie attributes and reload, logout,
captured SMTP reset links, expired/reused link and submitted-token rejection,
old-password rejection, new-password login and all prior session revocation.
Database assertions and same-cookie profile failure/recovery supplement those
screen interactions. Console/network logs and desktop/mobile screenshots are
retained under `output/playwright/` in the fixture directory. Expected rejection
responses and unrelated MIDI diagnostics must be reported separately from
new-screen failures. Capture is not live SES evidence.

The approved prerelease conversion limitation remains: historical v0 journals keep
millisecond timestamps when upgraded; fresh v1 replay derives second precision from
directory names. This fresh checked-in v1 history needs no conversion. Preserve
existing rows if converting historical evidence later; do not assert byte equality
of fresh/upgraded timestamps. The inherited full dependency audit remains failed;
this candidate's prerelease approval does not waive those advisories.

## Private practice verification

Run `pnpm run test:auth -- --practice` for this slice. It reuses fixture setup,
creates one uniquely isolated PostgreSQL database and runs `scripts/practice-browser.py`
through the actual application's browser modules and compiled server functions.
It skips the completed foundation/migration and auth-screen investigations.
Evidence includes two-user reads/writes, strict forged-field rejection, all private
endpoints without valid sessions, provisioning failure/retry, note preservation,
replacement rollback and concurrent replacement, real rendered transport/save controls,
account switching/cache clearing and anonymous local playback/recording.
The fixture uses browser API signup to prepare accounts; the existing `--browser`
evidence owns the signup/login/reset screen matrix. Browser evidence does not
establish hardware MIDI timing, content/admin permissions, integration or acceptance.
The retained dependency audit has 44 vulnerabilities, including five critical;
this slice changes no dependency pins and grants no risk acceptance.

## Method/module write verification

Run `pnpm run test:auth -- --content` for the bounded method/module slice. This
creates one unique PostgreSQL database, runs the actual app and drives
`scripts/content-browser.py` through the Playwright CLI. It skips completed
foundation/screens investigations. Run `--practice` separately for the private
practice regression. The browser imports `scripts/content-browser-client.mjs`
through Vite to exercise actual compiled server functions, including the module
update operation without adding a module-edit UI.

The write inventory is `createMethodServerFn`, `updateMethodServerFn`,
`createModuleServerFn`, `updateModuleServerFn`, and `POST`/`PUT /api/modules`.
There is no method API write route; `/api/modules/$id` is read-only. All these
writes validate strict field lists, require `requireDomainUser`, derive creation
authors from its stable ID and preserve authors on update. Repository writes
explicitly select editable fields. Module updates receive the selected ID and
persist the explicit destination `methodId`. Original authors alone edit methods
and modules; creating/moving a module also requires destination-method ownership.
An Admin toggle, role field, bearer token or claimed author cannot override this.

Method updates lock the selected row before checking its author. Module updates
lock their selected row; module creation and explicit moves lock the destination
method. Each permission check and dependent write shares one domain transaction,
so concurrent moves/ownership changes cannot pass a stale authorization check.
Profile provisioning remains a separate recoverable boundary before that transaction.
The existing session observer validates `/api/session`; identity changes remount
method/module forms, clear drafts/errors and refresh public state. Module creation
refreshes its method's list. Server rejection remains authoritative when UI state
is stale, with a visible sign-in/permission retry explanation.

Evidence is retained in `content-assertions.json`, `content-commands.json`,
`application.log`, SQL assertion logs and `output/playwright/` under the printed
fixture directory. It covers two authors, owner edits/moves, destination ownership,
forged ownership/token/role fields, missing/expired/revoked/forged cookies, failed
profile provisioning and retry, concurrent ownership changes, public reads,
rendered create/edit controls, permission errors and account switching.

Method/module deletion is covered by the separate deletion slice below. Legacy user APIs may
still need coordinated cutover; server helpers use `requireDomainUser` through `withAuth`.
Beat creation/copy and existing-beat edits/moves are covered by the separate slices below.
The browser Admin toggle still grants no trusted method/module authority; trusted
admin designation and beat exceptions remain unimplemented. Public browsing and
anonymous local practice stay available. Remaining ORM replacement, exact-candidate integration approval,
combined verification, human UX judgment and acceptance are separate obligations.
Dependency pins, 44 reported vulnerabilities, build warnings and the migration
precision limitation above are unchanged.

## Beat creation and copy verification

Run `pnpm run test:auth -- --beats` for actual server-function and `/api/beats` PUT
creation requests, rendered creation/copy controls and disposable two-user PostgreSQL.
Inspect the printed absolute directory's `beat-assertions.json`, `beat-commands.json`,
SQL logs, application log and `output/playwright/` browser console/network results.
Run `--content` and `--practice` separately for the integrated slices' regressions.

Creation inventory: `ModuleViewer` mounts the owner-only, account-keyed new
`BeatEditor`, which calls `createBeatServerFn`; `/api/beats` PUT without an existing
ID is the equivalent API entry. `saveBeatServerFn` and PUT with an existing ID
use the ordinary-author editing boundary described below. `BeatViewer` exposes `CopyBeat` independently of the persisted
Admin toggle; `copyBeatServerFn` requires an explicit owned destination module.
No other application creation/copy callers were found in the source inventory.

Both new operations use `requireDomainUser`. Strict schemas reject author, role,
token and relational note claims. The repository locks the destination module row
before checking its author, and holds that lock through nested beat/note insertion.
Copy reads only public source content and projects musical fields into fresh IDs;
it preserves the description and existing increment-or-prefix naming convention.
It never reads/copies private progress or performances. Source content and history
remain intact. Auth profile provisioning retains its separate retry boundary.

The picker lists the signed-in user's modules, offers existing method/module
creation controls when none exist, and can refresh destinations after returning.
Account changes unmount creation drafts and copy selections through the existing
validated session observer. Anonymous public reading and local practice remain.
Ordinary-author deletion has a separate proof below. Designated Admin enforcement and
remaining coordinated migration work is deferred; this is not complete beat mutation
authorization. No existing database or volume is reset by these checks.

## Existing-beat editing verification

Run `pnpm run test:auth -- --edit-beats`, then the separate `--beats`, `--content`
and `--practice` regressions. The editing proof uses actual compiled
`saveBeatServerFn` requests, the existing-ID `/api/beats` PUT branch and rendered
`BeatViewer`/`BeatEditor` controls with two users in a uniquely disposable
PostgreSQL cluster. Retain the printed directory's `beat-edit-commands.json`,
`beat-edit-assertions.json`, SQL before/after logs, application logs and
`output/playwright/` screenshots, console and network output. Browser/import
failures fail the check; real request statuses establish denials.

The complete existing-edit inventory is `saveBeatServerFn`, the existing-ID PUT
branch, `BeatRepository.updateBeat` and `BeatEditor` called from `BeatViewer`.
`ModuleViewer` also calls `BeatEditor` for integrated creation. Shared strict
schemas accept only explicit content fields and reject browser author/user/role,
token and note-identity claims. `requireDomainUser` validates the live session
and provisions its profile before domain work. A domain transaction locks the
selected beat, requires its author and, on a move, locks and requires ownership
of the destination module. These locks, checks, content-note replacement and
beat update share one transaction. Same-module edits need the beat author;
they do not acquire new parent ownership. Authorship is never written on edits.
Saved progress/best tempo, performances and performance-owned notes are preserved,
including notes with both beat/performance relations. Public beat/module content
reads, copy sources and edit responses exclude performance-owned notes so they
cannot enter editable musical content or public responses. No historical regrading
or versioning is added.

The existing editor uses the validated browser session/profile observer already
used by creation/copy. Owners can edit with Admin mode off. Account changes reset
editing state and drafts; successful edits refresh the module through its existing
creation refresh callback, and anonymous controls link to the existing sign-in route.
The editor reports a failed save with sign-in/author/destination recovery guidance.
Move inputs remain available through the server function and API; the existing
rendered editor continues to edit within its current module.

This is ordinary-author enforcement only. The agreed designated-admin exception
is **not implemented**: non-owner admins cannot edit through these paths yet.
Trusted roles and restricted toggle visibility remain coordinated follow-ups. This slice does not complete beat
authorization, the approved plan, integration, human UX judgment or acceptance.
Dependency audit failures, build warnings and migration limitations documented
above remain unresolved and are not waived by this proof.

## Ordinary-author deletion verification

Run `pnpm run test:auth -- --delete-content`, then `--edit-beats`, `--beats`,
`--content` and `--practice` separately. Each uses uniquely disposable PostgreSQL,
two browser accounts and actual compiled server functions/API requests. Retain
`deletion-assertions.json`, `deletion-commands.json`, SQL logs, application logs and
`output/playwright/` under the printed absolute directory. Browser/import failures
fail the proof; only actual request statuses establish denials.

The three deletion server functions and DELETE `/api/modules` and `/api/beats/$id`
share `contentDeletion.ts` and strict ID-only contracts. They call `requireDomainUser`;
only the selected item's author may delete. No client role, token, ownership claim
or persisted Admin toggle grants permission. The Methods page, ModuleList and
BeatViewer use one native confirmation explaining descendants and all users'
associated history loss; cancellation sends no mutation. Identity-keyed method
selection and a generation check discard stale confirmation state. Success clears
practice/navigation caches and refreshes the content route.

The domain transaction takes SHARE ROW EXCLUSIVE locks on the content, history
and User tables before selecting descendants and checking ownership. This bounded,
coarse approach serializes deletion with all domain writers, including inserts and
moves; it can briefly block unrelated writes. Lock contention/deadlocks fail the
whole transaction for retry. Auth tables and migration history are never locked or
written. It removes descendant content, every user's associated progress and
performances, and notes owned by removed performances. A dual-linked note belonging
to surviving history is detached from deleted content and retained. User.currentModuleId
is cleared for removed modules; ModuleProgress.currentMethodId stores a Method ID,
so surviving rows pointing at a removed method are cleared. Parent/sibling progress
survives deletion of a child. Responses contain only success, never private history.

Designated-admin authorization, combined verification, integration, human UX
judgment and acceptance remain separate.
