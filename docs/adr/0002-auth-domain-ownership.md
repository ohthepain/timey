# Separate authentication and domain ownership

The approved [auth-first plan](../plans/auth-and-persistence-migration.md) uses
Drizzle for Better Auth while application repositories stay on Prisma, avoiding a
temporary Prisma auth adapter. Auth owns identity and sessions in `auth` and its
continuous history in `auth_migrations`; Prisma retains domain/profile ownership
and history. Separate PostgreSQL owners prevent either migration tool from
resetting the other's data during the later ORM transition.

A domain profile uses the validated auth ID directly. The clients have no shared
transaction, so profile provisioning is idempotent, fails closed and permits retry
after auth signup has committed. Email never links identities. The nullable legacy
Keycloak mapping supports the coordinated cutover without granting new authority
to existing callers. See [setup and boundary behavior](../../AUTH_SETUP.md).

Private-practice progress/performance operations now use this boundary. Browser
session state controls persistence affordances and cache lifetime; only the
validated server session/profile chooses the owner. Method/module creation and editing use it too; beat and deletion operations
remain on the legacy boundary until their coordinated cutover. Recording replacement stays
inside a domain Prisma transaction; auth/profile provisioning still has the
separate recoverable boundary described above.

Method/module authorship comes only from the validated identity on creation and
is immutable during edits. Domain transactions lock the selected content before
checking its author and lock a destination method before checking ownership on
module creation/moves. These checks and writes are atomic within Prisma; no
method/module Admin override exists. Browser session state controls affordances,
clears drafts on identity changes and never supplies authority. See the
[write inventory and proof](../../AUTH_SETUP.md#methodmodule-write-verification).
