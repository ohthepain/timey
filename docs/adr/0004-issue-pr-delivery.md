# Deliver completed issues through pull requests

The approved policy is one PR per complete issue, opened after work finishes,
with factory merging permitted after required checks pass. Server-owned operations
assemble independently reviewed contributions, retain completion and publication
records, and enforce the same policy through CLI and UI. Existing assignments keep
their original bases, scope, authority and merge policy; historical receipts remain
readable. Assembly, remote merge, verified integration and human acceptance are
separate outcomes.

Persist external operation intent before effects and discover interrupted effects
before retrying. Ambiguous or absent discovery after an uncertain request blocks
retry. A local lock cannot protect against another remote writer. GitHub's
[REST merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
and [GraphQL merge input](https://docs.github.com/en/graphql/reference/pulls)
condition on the head, without an expected target revision. The production adapter
therefore supports publication and discovery but deliberately refuses merging.
A separately verified merge-queue implementation would need to test the actual
combined result and retain its identity before this restriction can change.
Fixture conditional merging proves the shared protocol, not GitHub enforcement.
