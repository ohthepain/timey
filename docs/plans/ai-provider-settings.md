# AI provider settings

Shared understanding and implementation were approved by the user with “lfg”.
The implementation is present locally. Verification is recorded below.

## Requested behavior

- Rename the Settings menu and dialog labels from Project settings to Factory settings.
- Add an AI providers page listing the supported providers.
- Offer Setup for a provider that has not been configured.
- Once configured, list the provider's available models.
- Let the person choose which models are enabled in Factory.
- Populate model selectors from those enabled models.

## Existing decisions and behavior

[ADR 0025](../adr/0025-integrate-native-coding-agents.md) keeps authentication,
billing, and coding execution with the installed native agents. Conversations
retain their owning agent; provider changes require an explicit handoff. This
request does not yet change those decisions or add another provider integration.

Settings is currently project-scoped. Model choices come from the installed
folder settings reference. Native agent startup checks some advertised model
metadata but does not expose provider setup or a discovered model catalog in
Settings. Started issue execution settings retain a frozen snapshot.

## Design review status

The interview and consolidated implementation defaults were confirmed before
implementation.

## Confirmed decisions

The user clarified that Timey is this project. Factory is installed into the
codebase of a project, and its settings apply only to that project. Provider setup
and model enablement do not create shared cross-project Factory settings.

Use Factory settings as the user-facing name for this configuration. Project
continues to mean the codebase into which Factory is installed. This naming
decision does not request an internal module or file rename.

Disabling a model must interrupt all affected Factory work in this project,
including flows, chats, and helpers. Other providers' work continues. Disabling
does not merely hide a model from dropdowns.

Factory must support automatic disablement when a model's allowance is exhausted.
Each provider has independently configurable warning and disable thresholds,
expressed as remaining allowance. The warning default is 5%; the disable default
is 2%. These replace the previously proposed 10% default.

At or below the warning threshold, show a persistent in-app warning in the main
UI and Factory settings while work continues. At or below the disable threshold,
disable the affected models and interrupt their work.

Apply quota restrictions at their reported scope. A shared provider limit pauses
the provider's models; a model-specific limit pauses only the affected models.
Provider quota reporting and reset semantics require factual validation rather
than assuming that every model shares one allowance.

Manual model choices remain separate from temporary quota pauses. Fresh quota
data confirming sufficient allowance restores availability automatically, but
manually disabled models remain disabled. Interrupted work requires explicit Resume.

Unknown quota blocks a provider unless the person explicitly enables Allow work
without quota monitoring. Do not invent a percentage. Confirmed exhaustion still
stops affected work even when that override is enabled.

Discover models from each configured native agent and offer the models the Factory
integration can run. This expands the earlier small fixed catalog agreed in the
[native-agent plan](anthropic-google-model-support.md). It does not add manual
model IDs, custom endpoints, or another provider integration.

On upgrade, preserve model choices referenced by current defaults, saved issue
settings, and configured helpers. Newly discovered models start unchecked.

Setup guides installation and vendor sign-in, opening a browser or native
terminal when needed, then rechecks readiness. Setup sends no paid model request.
Credentials remain with the vendor's native agent and are not copied into the project.

Use the lowest remaining allowance across applicable quota windows. Respect each
window's scope: a shared weekly limit can pause a provider even while its shorter
window has capacity; a model-specific window affects only its covered models.

Check quota before starting AI work and refresh every 30 seconds during active
work where supported. Observations older than two minutes are unknown and follow
the explicit unmonitored-work policy. Reporting and cancellation delays mean
thresholds cannot guarantee an exact spending cutoff. Unsupported fresh quota
reporting must remain visibly unknown rather than use unofficial credential access.

Interrupt affected AI work promptly and start no further steps. A push, merge,
or publication already underway must reach a recorded outcome or be reconciled
before the pause finishes. Do not assume cancellation reversed an external effect.
Interrupted work requires explicit Resume.

## Implementation defaults

- Keep manual model choices and thresholds in project-scoped Factory
  configuration. Keep credentials with the native agent and live account quota
  observations local to the execution environment.
- Discover models after Setup and on explicit Refresh. Preserve choices by stable
  provider/model identity. Retain a missing model's saved choice as unavailable
  rather than deleting its history or choosing a replacement.
- Offer enabled, supported, currently usable models in selectors. Keep an invalid
  saved default visible with its blocking reason; never silently replace it.
  Retained execution snapshots and conversation history remain intact.
- Reuse the existing explicit Save and unsaved-change behavior. Saving a model
  disablement or stricter threshold applies its execution policy immediately.
- Validate percentage settings so the disable threshold is below the warning
  threshold and both are within 0% to 100%.

Provider setup compatibility still needs implementation evidence.

## Quota evidence and limits

Provider allowance may be shared with activity outside this project. Project-local
settings can govern only this project's Factory work.

- Codex exposes multiple account allowance windows with used percentages and reset
  times through the existing `codex-quota.mjs` integration. Its current reader
  supports ChatGPT accounts and caches observations for five minutes.
- [Claude's SDK quota events](https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent)
  and [status-line data](https://code.claude.com/docs/en/statusline#available-data)
  can include allowance utilization and reset information, but fields may be
  absent. A complete fresh snapshot through the current headless integration has
  not been demonstrated.
- [Gemini's native quota types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/types.ts)
  include per-model remaining fractions and reset times. These native internal
  data are not yet exposed through Factory's ACP adapter. ACP context-token usage
  does not establish remaining account allowance.

No missing percentage may be invented or inferred from chat context utilization.
Unknown or stale allowance requires the explicit override above. Subscription
allowances, request-rate limits, and API credit balances need distinct meanings;
a shared percentage calculation is not yet established for every account type.

## Setup evidence and limits

Native sign-in persistence belongs to the vendor's agent. Factory must not extract
tokens or copy them into a project. Explicit native sign-in may change the OS
user's shared agent account even though Factory settings remain project-local.

- [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  exposes account reads, native login start/completion/cancellation, and model lists.
- [Claude CLI commands](https://code.claude.com/docs/en/cli-reference) expose native
  auth status and login. Terminal-free login completion and cancellation need a
  compatibility probe before being promised.
- [Gemini ACP](https://geminicli.com/docs/cli/acp-mode/) and
  [native authentication](https://geminicli.com/docs/get-started/authentication/)
  support explicit browser sign-in. A manual-code fallback can need a terminal.

Installation, sign-in, advertised models, manual model enablement, and known quota
are separate facts. A successful model-list response is not proof of authentication
or access to every listed model. Setup must not infer an unlimited allowance from
successful initialization.

## Implementation and verification

Factory settings now contains AI providers for OpenAI, Anthropic and Google.
The supported native discovery paths send no model prompt. Guided Setup opens
installation instructions or native vendor login; returning to Factory rechecks
readiness, and explicit Refresh remains available. No credentials are copied.

Project choices and thresholds are saved in `user/ai-providers.json`; native
observations are local under `.issues/factory-ui/`. Missing models retain saved
identity. Enabled, advertised, usable models feed selectors; unavailable defaults
remain visible. Policy checks cover native and Codex turns, including helpers,
and Flow blocks. Protected publication/Git operations retain an outcome while
the route pauses. Active interruption is idempotent.

Codex account allowance is polled through its native metadata interface while
Factory runs, including while idle so selectors can recover after a reset.
Claude's scoped events can establish exhaustion or a reported percentage but
cannot prove a complete fresh snapshot. A documented Claude `credits_required` rejection blocks the shared provider even
without a percentage; request-rate rejections are not invented account exhaustion.
If an exhausted native allowance has no reported reset or supported fresh read,
Factory cannot verify recovery until the native agent supplies new evidence.
Gemini ACP exposes no supported account
allowance snapshot here. Their unknown-quota policy remains explicit. Context
window usage is never converted into account allowance. Vendor request rejection
and reporting delays can still precede a quota observation.

Live Codex account/model discovery succeeded without a model prompt. Native
Claude/Gemini discovery and interruption are covered by disposable protocol
executables; authenticated vendor setup and live model access were not exercised.
The local machine has no `claude` or `gemini` command on its normal PATH.

Automated proof includes provider policy/setup checks, native interruption checks,
chat/settings regressions, a protected-publication Flow check, and the browser
scenario documented in the verification guide. The broad regression run exposed
a folder-copy membership failure that also reproduces on unchanged HEAD; it is
outside provider settings. Final logs and screenshots are retained with the
verification evidence for this change.
