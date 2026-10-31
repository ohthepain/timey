# Separate authentication and domain ownership

The approved [auth-first plan](../plans/auth-and-persistence-migration.md) uses
Drizzle for Better Auth and for application domain data, avoiding a temporary
Prisma auth adapter. Auth owns identity and sessions in `auth` and its continuous
history in `auth_migrations`; domain practice content and profiles live in the
`domain` schema with history in `domain_migrations`. Separate PostgreSQL owners
prevent either migration stream from resetting the other's data.

A domain profile uses the validated auth ID directly. The clients have no shared
transaction, so profile provisioning is idempotent, fails closed and permits retry
after auth signup has committed. Email never links identities. The nullable legacy
Keycloak mapping supports the coordinated cutover without granting new authority
to existing callers. See [setup and boundary behavior](../../AUTH_SETUP.md).

Private-practice progress/performance operations now use this boundary. Browser
session state controls persistence affordances and cache lifetime; only the
validated server session/profile chooses the owner. Method/module creation and editing use it too; beat creation/copy also use it; ordinary-author deletion now uses the same validated session boundary. Recording replacement stays
inside a domain database transaction; auth/profile provisioning still has the
separate recoverable boundary described above.

Method/module authorship comes only from the validated identity on creation and
is immutable during edits. Domain transactions lock the selected content before
checking its author and lock a destination method before checking ownership on
module creation/moves. These checks and writes are atomic within the domain
database; no
method/module Admin override exists. Browser session state controls affordances,
clears drafts on identity changes and never supplies authority. See the
[write inventory and proof](../../AUTH_SETUP.md#methodmodule-write-verification).

Beat creation/copy locks the destination module and checks its author in the same
domain transaction as insertion. Authorship comes from the validated profile;
copy projects public musical content into fresh identities without private history.
Existing-beat edits/moves now also use the validated session/profile boundary.
The domain transaction locks the beat before checking its author and locks a
changed destination module before checking ownership. It preserves authorship,
progress and performances, replacing only content notes without performance
ownership. Ordinary author editing is independent of the client Admin toggle;
identity changes reset editing drafts. The designated-admin non-owner exception
remains unimplemented and must be added in the coordinated Admin slice. Retirement remains separate. See [edit inventory and proof](../../AUTH_SETUP.md#existing-beat-editing-verification).

Ordinary-author deletion checks the selected item's author and cleans the complete
descendant/history set within one domain transaction. Coarse domain table locks
protect against phantom descendants and new history from concurrent insertion or
moves; this intentionally trades write concurrency for a bounded reliable cleanup.
Auth identities, sessions and both migration histories are outside this write set.
Performance-owned notes follow their performance even when also linked to content;
surviving history is detached from removed content. See the
[deletion semantics and proof](../../AUTH_SETUP.md#ordinary-author-deletion-verification).
