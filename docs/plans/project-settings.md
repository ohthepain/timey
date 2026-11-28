# Project Settings

The Flow header gear opens Settings across the project workspace. Settings
categories replace the project sidebar. **Close** restores the previous project
view. Direct links use `/?settings=issues`, `lifecycle`, `git`, `storage`, `skills`,
`providers`, `prompts`, or `hotkeys`. The Admin tab remains at
`/?projectTab=admin`.

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

Issue Storage shows named destinations, per-issue storage profiles, project role
selections, and existing Git publication options. Changing a role uses a checked
migration. Profile edits affect future selections. Existing issues move through
their own controls. See [Configure and move Factory stores](../agents/issue-stores.md).
Publication option changes take effect after Factory restarts. Incomplete GitHub
configuration appears as a status without blocking the other Settings pages.
Secret values cannot be edited.

Skills uses the installed skill catalogue and checks every declared member of the
required libraries in `user/skills/requirements.json`.

Prompts provides independent Project, Issue, Report and Investigation chat editors.
Effective defaults come from `project-prompt-defaults.mjs`. Overrides are stored in
this project's `user/factory-preferences.json`. Restoring a default removes that
override after Save. Work authorization and registered operation guards remain
separate from conversational prompt text.

## AI providers

Every provider starts disabled on a fresh installation. Upgrades retain the
existing provider behavior and saved model and quota settings.

**Enabled** applies as soon as Factory saves the checkbox change. Disabling a
provider hides its settings, clears its quota warnings, and blocks new requests.
Requests already sent can finish. Factory suppresses further quota warnings for
the provider while it is disabled. Re-enable the provider to see its previous
configuration. Use **Save** to apply changes to models or quota thresholds.

## Saving and hotkeys

Settings forms use explicit Save buttons. Navigating between categories or closing the
window with changes offers Save, Discard and Cancel. Save validates and persists
before navigation completes. Validation failures and Cancel retain the draft.
Restore actions also remain drafts until Save. Concurrent saved edits are checked
using configuration revisions. Browser unload uses its native unsaved-change guard.

Save uses the confirmed write response to update the form, revision, and saved
baseline. Closing after a successful save requires no further settings or hotkey
reads. Saving unchanged fields performs no write. Storage configuration saves
return the confirmed local configuration without reading shared coordination.
Changing only a project storage role skips the configuration write and uses the
checked migration. Failed migrations retain their selected destination as a draft.
Hotkey saves apply the confirmed bindings directly.

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
- `node --test scripts/project-settings-save.check.mjs scripts/store-settings.check.mjs`
  checks save completion, closing, retries, and storage saves during a coordination outage.
- `node scripts/flow-browser.mjs --project-settings` exercises actual browser
  navigation, drafts, explicit saves, hotkey changes and sources. It saves
  `project-settings-proof.json` and screenshots in its reported evidence directory.
  Run it with `--sidebar-labels` to check that expected validation errors do not
  fail later scenarios. Each deliberate rejection checks its HTTP 400 response
  and consumes one matching console entry; unexpected console errors still fail.
  The aggregate browser checks also verify project defaults and explicit lifecycle
  initialization through the Settings Issues and Issue Lifecycle pages.

GitHub authentication is simulated in focused backend tests. Browser proof uses
a temporary project and deterministic skill discovery. A live configured GitHub
connection requires its actual credentials and network access.
