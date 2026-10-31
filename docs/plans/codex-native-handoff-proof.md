# Native Codex handoff proof

This is milestone 1 of the [implementation plan](codex-owned-issue-execution.md),
starting at `bd52882a9265acf806c11dcbd1be429e01b3b65e`. It is an experimental
handoff alongside the current adapter, not a factory runtime cutover.

## Supported transport

The [official desktop command reference](https://learn.chatgpt.com/docs/app/commands)
documents `codex://new?path=...&prompt=...` for a workspace and prepared composer,
and `codex://threads/<id>` for opening an existing local chat. New-chat links do
not send the prompt. Pressing Send is a separate, visible user action.
The browser receives no native chat ID or completion callback from this link.

`/native-chat?issue=FULL_ID` on the candidate factory server is the proof page.
Opening or refreshing it reads records only. Prepare discussion atomically reserves
one request and returns one new-chat link. The prepared prompt asks the native
chat to register itself through `scripts/factory-native-chat.mjs bind`, which reads
its own `CODEX_THREAD_ID`. The native smoke test confirmed that variable is
available in the newly opened chat and that its saved identity matches the native
Codex tool's thread identity.

Bindings live in the selected issue's `nativeChat` field in the existing shared
progress store. `updateProgress` serializes changes with the existing record lock
and preserves other issue fields. Once bound, future requests return the exact
existing-chat link. No model client, HTTP listener, or app-server connection is
needed for local registration or reading status.

## Safety and deliberate limits

This first proof supports discussion only. It rejects title-only reports and
issues with known legacy chats or outstanding action claims; adoption of those
issues belongs to migration. Wrong request IDs, changed reports, conflicting chat
identities, cross-issue reuse, corrupt records, and unknown locks cannot replace
a binding. It changes no issue lifecycle state or approval.

Repeated or concurrent preparation requests return pending status without another
creation link. A lost response, abandoned draft, or changed pending report needs
reconciliation; this slice has no automatic reset or retry that creates a chat.
An externally copied creation URL can still open another native draft. Only one
chat can claim the issue; a second registration rejects and its prompt instructs
the agent to stop. The URL mechanism cannot enforce native draft uniqueness.

Registration records the identity reported by the local chat environment; it is
not cryptographic proof of provider identity or an approval receipt. Opening an
existing-chat link sends no prompt, never recreates a missing/archived chat, and
does not claim the native chat is idle or available.

The existing factory model routes remain unchanged for now. This proof page is
not linked into the production issue screen. Do not use it for active issues until
ownership exclusion across legacy and native execution is implemented in the
later lifecycle/cutover milestones. The disposable proof creates no authoritative
queue records and does not deploy the candidate server.

## Evidence and remaining limits

The new `factory-native-chat.check.mjs` is included in both chat and aggregate
factory checks. It exercises the actual shared record writer, subprocess status
read, and authenticated HTTP surface with disposable projects. It checks no
creation on inspection, concurrent request handling, persisted registration,
exact reopen links, stale/conflicting records, and preservation of other progress.
A failing model-connection stub and absent child process check ensure the proof
routes do not initialize the factory model transport.

A real Chrome session rendered the disposable proof page, showed no chat before
Prepare discussion, and then displayed its encoded native draft link. Local
runtime details and screenshot are retained under `.issues/evidence/` as
`native-chat-proof-live.json` and `native-chat-handoff-prepared.png`.
These initial files contain disposable project identity. Subsequent native proof
is recorded in `native-chat-handoff-result.json`; the registered factory view is
captured in `native-chat-handoff-registered.png`.

Computer Use rejected access to `com.openai.codex` for safety reasons. Native
composer inspection and pressing Send cannot be automated through that tool.
The user opened the prepared draft, pressed Send, and confirmed HANDOFF VERIFIED.
Native chat inspection independently showed its completed registration command
with exit zero, correct disposable workspace, and final HANDOFF VERIFIED response.
The saved binding and refreshed factory page both identified that same actual
chat. The registered factory view offered Open issue chat rather than another
creation link.

After registration, the identified disposable proof server was stopped; its HTTP
listener returned ECONNREFUSED. The local status command still returned the same
chat identity and native chat inspection still showed the completed, idle chat.
The live factory was not stopped. Broader lifecycle execution with the server
stopped belongs to milestone 3.

Clicking the registered existing-chat link after server shutdown detached browser
control while handling the command. Its exact target and the chat's continued
accessibility are verified; the foreground native screen after that click remains
unobserved. Do not claim independent visual confirmation of reopening.

All 517 factory tests, typecheck, unit tests, and production build passed for the
implementation snapshot. Full verification failed on formatting in pre-existing
verifier edits and a capture-browser scenario timeout. Own changed-file formatting
passed. The step-audit command passed with Fallow skipped by current configuration.
Evidence paths are retained in `native-chat-handoff-result.json`. The implementation
remains uncommitted and undeployed; creation and registration are demonstrated,
while visual reopening and full verification remain incomplete.
