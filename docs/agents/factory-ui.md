# Local factory UI

Run `npm run factory:ui -- --project /absolute/path/to/timey` from a checkout
containing this adapter. Open the printed loopback URL. The project must already
have its local issue queue and factory registry; the UI never initializes or
replaces either. The selected checkout is the integration target, so choose the
authoritative project rather than an old worker checkout. Use `--port NUMBER`
only when a fixed local port is needed.

The queue and issue screens read actual reports and the dispatch ledger through
the existing factory helper. Refreshing and filtering are read-only. Lifecycle
stages come from the configured role mapping. Human input remains separate from
stage, worker completion and code integration. Links use the report's Parent,
Blocked by and Related sections; reverse links are computed from those explicit
references. Reports are displayed as escaped text, never executable HTML.

## Separate manual actions

1. **Review queue with Codex** starts one read-only coordinator chat. It proposes
   work but does not change recommendations or launch workers.
2. **Save these recommendations** saves the reviewed assignments using the existing
   ledger helper. A changed queue or source revision requires another review.
3. **Start worker** shows the saved scope, checks, integration policy, current
   revision and human obligations. Confirmation reserves exactly that assignment,
   creates an isolated Git checkout at its saved base, and starts one CLI chat.
4. **Review integration** appears for completed code actions. Its separate
   confirmation starts a coordinator chat for that exact candidate. Human-first
   actions require explicit approval. The server independently reruns combined
   verification and the strict saved-base audit before recording integration.

Even the saved `automatic` merge policy requires the explicit integration action
in this UI. No worker completion, saved answer or refresh starts a follow-up action.
Nothing in this interface accepts or closes issues. Handle human answers,
hardware checks and acceptance in the coordinator chat using the installed
human-input protocol. The UI invokes that protocol's operation-specific structural
guards before dispatch and integration; those checks do not replace semantic
review of the answers and candidate scope.

## CLI connection and recovery

The adapter uses the installed `codex app-server --listen stdio://`, its existing
login and configured model. It does not change authentication or model settings.
The protocol boundary was checked against CLI 0.164.0 and its generated JSON
schemas. The app-server interface is marked experimental by that CLI; retest this
adapter after upgrades. See the [official app-server protocol](https://learn.chatgpt.com/docs/app-server).
CLI-created chats have durable IDs; their appearance in the desktop sidebar is
not established by this adapter. Chat-tool launches continue to use the existing
native transport. The UI does not take over unknown native chats.

Permission requests from a connected chat are shown for an explicit allow or
decline decision, scoped to the pending request. Unsupported requests fail closed.
A missing CLI, failed setup or disconnected conversation retains its saved claim,
checkout and ID. Do not retry creation blindly. Known interrupted chats can be
continued explicitly within the original assignment; no resumption occurs on
page load. A server restart displays saved runs as disconnected. The UI refuses
uncertain setup and leaves it for coordinator reconciliation.

Local history and transcripts live under ignored `.issues/factory-ui/`. A server
ownership lock prevents concurrent UI writers. A previous ownership lock must be
reconciled after an abnormal exit: inspect its PID and saved runs before removing
only a confirmed dead server lock. Never remove an integration lock as routine
cleanup. Failed integrations retain that lock and the actual checkout state;
continue the owning run only after reviewing it, or reconcile in the coordinator
chat. No reset, stash, forced merge or automatic lock recovery is performed.

The HTTP service binds to 127.0.0.1, validates Host and Origin, requires its local
session cookie and explicit JSON action headers, and exposes a fixed set of
operations. It has no arbitrary command endpoint or cross-origin API. Keep it
local. Closing the server disconnects CLI work; inspect retained history before
continuing.
