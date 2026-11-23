# AI provider settings

This design interview is ongoing. Shared understanding and implementation approval
have not yet been confirmed for this change.

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

## Open decisions

- Whether each provider has its own threshold.
- Which quota windows determine remaining allowance, how model-specific limits
  differ from shared provider limits, and how stale quota information affects eligibility.
- What Setup performs and how readiness is verified.
- Which advertised models Factory can support and how the list refreshes.
- Initial enablement, newly discovered models, and unavailable models.
- How saved defaults and retained conversations behave when model availability changes.

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
A configurable remaining-allowance percentage threshold must temporarily disable
all models from the affected provider when the reported percentage falls below it.
The user supplied no threshold value yet. Provider quota reporting and reset
semantics require factual investigation before specifying a universal percentage.

Manual model choices remain separate from temporary quota pauses. Fresh quota
data confirming sufficient allowance restores availability automatically, but
manually disabled models remain disabled. Interrupted work requires explicit Resume.

Unknown quota blocks a provider unless the person explicitly enables Allow work
without quota monitoring. Do not invent a percentage. Confirmed exhaustion still
stops affected work even when that override is enabled.

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
Unknown allowance requires the explicit override above; stale-data policy remains
undecided. Subscription
allowances, request-rate limits, and API credit balances need distinct meanings;
a shared percentage calculation is not yet established for every account type.
