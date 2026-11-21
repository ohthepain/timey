# Project Settings

The Flow header gear opens a project Settings window with sidebar navigation.
Direct links use `/?settings=issues`, `lifecycle`, `git`, `storage`, `skills`,
`prompts`, or `hotkeys`. The existing Admin tab remains at `/?projectTab=admin`.

## Configuration owners

Issues edits project `folder.md` defaults through the existing folder-settings
API. Each control shows its effective stored identifier and source. Folder and
issue overrides retain their existing precedence.

Issue Lifecycle shows the effective triage labels and their sources, the project
override at `.issues/triage-labels.md`, and whether it exists. The installed
local-issues template supplies setup defaults when that file is missing. Open
file uses the existing platform file opener. Human input policy comes from the
installed `guard.mjs` adapter and remains read-only. There is no policy preset.

Git shows configured GitHub App credential references and availability. Connection
tests use the existing credential resolver and report authentication and required
contents and pull request permissions. Maintenance buttons open the existing Admin
operations, retaining their previews, confirmations and guards.

Issue Storage shows local Markdown or the existing GitHub queue provider. Supported
GitHub publication options can be saved. Provider selection and issue migration
are separate operations. Saving Settings does not move reports. Publication option changes take effect after
Factory restarts, which the page and saved status explain. Incomplete GitHub
configuration is shown as a status without blocking the other Settings pages. Secret names and
values cannot be edited. No PostgreSQL or DynamoDB provider is added.

Skills uses the installed skill catalogue and checks every declared member of the
required libraries in `user/skills/requirements.json`.

Prompts provides independent Project, Issue, Report and Investigation chat editors.
Effective defaults come from `project-prompt-defaults.mjs`. Overrides are stored in
this project's `user/factory-preferences.json`. Restoring a default removes that
override after Save. Work authorization and registered operation guards remain
separate from conversational prompt text.

## Saving and hotkeys

Settings uses explicit Save buttons. Navigating between categories or closing the
window with changes offers Save, Discard and Cancel. Save validates and persists
before navigation completes. Validation failures and Cancel retain the draft.
Restore actions also remain drafts until Save. Concurrent saved edits are checked
using configuration revisions. Browser unload uses its native unsaved-change guard.

Hotkeys stores project bindings for Dictate HOT, Dictate COLD, New Note and New Issue. Defaults
reflect the existing Alt+D dictation, Alt+N note capture and N issue capture.
Duplicate combinations are rejected after normalization. Dictate HOT records while
the shortcut is held and stops when the key or a modifier is released, or the
window loses focus. Dictate COLD toggles recording on each press and is unbound by
default. Both shortcuts use the hovered text or focused editable field. Microphone
availability and permission remain controlled by the browser.

## Focused verification

Run the required formatting and Fallow checkpoint before these checks.

- `node --test scripts/project-settings.check.mjs` checks configuration projection,
  sources, secret redaction, safe storage saves and connection results.
- `node --test scripts/project-preferences.check.mjs` checks project isolation,
  prompt overrides, duplicate bindings, restoration and stale saves.
- `node scripts/flow-browser.mjs --project-settings` exercises actual browser
  navigation, drafts, explicit saves, hotkey changes and sources. It saves
  `project-settings-proof.json` and screenshots in its reported evidence directory.

GitHub authentication is simulated in focused backend tests. Browser proof uses
a temporary project and deterministic skill discovery. A live configured GitHub
connection requires its actual credentials and network access.
