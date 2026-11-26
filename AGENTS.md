# Agent guide

Follow this repo's adapters over skill defaults.

- Before progress updates or final replies, read the [communication guidance](docs/agents/operating.md#communication).
- For `/factory`, issue browsing, human input, or worker launches, read the [factory interface](docs/agents/factory.md).
- Before ticket, triage, spec, or implementation work, read [tracker conventions](docs/agents/issue-tracker.md).
- Before code exploration or changes, read [domain and documentation conventions](docs/agents/domain.md); maintain affected docs with the code.

| Rule                                                                                                                                           | Enforcement                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting Flow Work authorizes in-scope implementation. Continue independent work when a specific decision, permission or operation is blocked. | [Work start and Retry regression](scripts/flow-executor.check.mjs) checks the executor instructions against the saved Asset Storage report that previously stalled. |
| If Factory is unreachable, use [Factory health](docs/agents/factory-ui.md#diagnosing-a-heap-crash) to check for a recorded Node heap crash.    | [Factory restart checks](scripts/factory-restart.check.mjs) exhaust Node's heap and verify that the offline health command identifies the crash.                    |
| Preserve confirmed Codex terminal status and partial output when forwarding a provider pause.                                                  | [Provider pause regression](scripts/provider-settings.check.mjs) exercises quota expiry, interruption, and terminal acknowledgement.                                |
