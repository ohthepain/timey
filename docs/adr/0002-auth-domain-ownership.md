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
