# Authentication foundation

This is the server foundation for the coordinated authentication/admin migration.
Existing UI and application callers still use Keycloak. Use [the approved plan](docs/plans/auth-and-persistence-migration.md)
for the remaining cutover, screens, mail, permissions, deletion and retirement work.
Do not point existing callers at the new boundary until their authorization is implemented.

## Install and configure

Use the Node version in `.nvmrc`, `npm ci`, then `npm exec --no -- prisma generate`.
Application and auth now use Zod 4.6.7 under the explicit follow-up approval.
The auth workspace retains the server runtime boundary. Older framework packages
keep their own required Zod 3 dependencies; these are separate, unresolved audit findings.
The approved dependency pins are in the manifests/lock; do not use force, overrides,
or legacy peer resolution to substitute a different combination.

Supply server environment variables through the process environment or an untracked
local environment file. None are `VITE_` variables:

- `AUTH_DATABASE_URL`: PostgreSQL auth owner connection. Owns only `auth` and
  `auth_migrations`, including their tables and migration history.
- `DATABASE_URL`: existing Prisma domain connection, explicitly selecting
  `?schema=domain` in a fresh setup. Its distinct owner owns only the domain schema.
  Preserve the existing schema selection on an existing installation; moving it
  is a separate operation, not part of this foundation.
- `BETTER_AUTH_URL`: public application origin, HTTPS except for loopback development.
- `BETTER_AUTH_SECRET`: a generated secret of at least 32 characters, stable across
  application instances/restarts. Do not use the disposable fixture value.

Deployers provision schema owners and credentials separately. On an already
verified target, connect as the auth migration owner and run:

```sh
psql "$AUTH_DATABASE_URL" -v ON_ERROR_STOP=1 -f auth/schemas.sql
npm run auth:migrate
npm exec --no -- prisma migrate deploy
```

`auth/schemas.sql` creates only the two auth-owned schemas under the connected owner;
it grants no roles. The domain owner must have no rights to alter/drop auth objects,
and the auth owner must have no rights to alter/drop domain objects. The fixture
checks these denials. Use separately scoped runtime credentials when deploying;
this work provisions no real roles, databases, AWS resources or external mail.
Never run Prisma reset or Drizzle push against an existing installation as setup.

To append an auth schema change, edit `auth/schema.ts`, run `npm run auth:generate`,
review the generated SQL/snapshot and check them in together. `auth/drizzle.config.ts`
limits generation to auth and stores history in `auth_migrations.__drizzle_migrations`.
Prisma owns its existing domain migrations and `_prisma_migrations`. Keep the auth
history continuous when domain storage later joins Drizzle. Do not copy the old
disposable experiment's history or dependency-probe table into this new foundation.

## Request and session boundary

`/api/auth/$` forwards real Requests/Responses through the installed TanStack Start
1.114 API route integration. Returning the original Response preserves Set-Cookie.
Configuration loads lazily behind the installed framework's `serverOnly` boundary;
secrets and PostgreSQL drivers belong exclusively on the server. Database sessions
use Better Auth's default lifetimes, cookie caching disabled, email/password and
username login, current-session logout and reset-session revocation configuration.
Password-reset delivery and the app-native client/screens are pending; this slice
configures no mail callback and claims no working reset-email flow.

`GET /api/session` returns only the validated user's domain `userId`, with no-store
caching. `requireDomainUser` is also usable inside later server functions: its default
Request comes from the installed `getWebRequest` API. A missing, invalid, expired or
revoked session yields 401. Auth persistence is consulted on every request. Browser
IDs, bearer tokens and email matches cannot supply identity to this path.

Profile provisioning uses that trusted ID as the Prisma User primary key. Existing
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
npm run test:auth
```

For a browser or compiled-server-function check against the same disposable data,
run `npm run test:auth -- --pause-for-browser`. After the HTTP/provisioning assertions,
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

The proof covers fresh/repeated migration replay and owner isolation, Prisma shadow
replay preservation, real signup cookies and persisted sessions, invalid/expired/
revoked/logout and foreign-origin rejection, persistence across an app restart,
stable IDs, concurrent provisioning, injected database
failure, same-cookie recovery and legacy-email collision rejection. Browser UX,
reset email, admin permissions, deletion, production deployment and live SES are
later checks. It does not claim those paths are verified.

The approved prerelease conversion limitation remains: historical v0 journals keep
millisecond timestamps when upgraded; fresh v1 replay derives second precision from
directory names. This fresh checked-in v1 history needs no conversion. Preserve
existing rows if converting historical evidence later; do not assert byte equality
of fresh/upgraded timestamps. The inherited full dependency audit remains failed;
this candidate's prerelease approval does not waive those advisories.
