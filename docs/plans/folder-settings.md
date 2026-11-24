# Folder and project settings

Design agreed November 18, 2026, after three interview rounds. The user's final
"yes to all" confirmed the remaining decisions and shared understanding.
The agreed behavior is implemented locally. Live verification and user acceptance
remain separate from automated checks.

## Requested behavior

An issue folder has a `folder.md` in the directory. Existing issue folders without
one receive a settings file. A new subfolder of an issue folder also receives one.

An ordinary folder without settings shows its name, the label **System folder**,
and a button to create `folder.md`. Its sidebar has no **View assigned issues**
button. It does not show issues.

The issue folder page places **Is default folder** first. A new issue uses the
default issue folder unless the person chooses a folder. Individual issues can
target branches other than their folder's default target branch. Only issues
targeting the folder's default branch can be grouped.

Folder controls include the branch, skill, model, and effort level. A missing
value or `default` inherits from parent folders, then project settings. The page
also includes a select-all checkbox, an Open or Closed view switch, a shared search input with
Search and AI Search buttons, and a way to copy the selected selection strategy
to the user folder. Open in Finder and Delete folder use adjacent icon buttons.

A magic wand adds missing settings fields with `default` values. Broken settings
show a red wand. Repair never removes existing fields. Its tooltip
lists the missing fields after **Add missing fields:**. With no missing fields,
the tooltip reads **Your folder.md is up-to-date**.

A system `folder.md` documents the supported inherited fields and possible values.
Adding a field also updates this reference. Project settings and missing-field
repair cover every field listed there. The reference does not configure a folder
and excludes **Is default folder**. Comments in folder settings explain that
folder-specific exception.

Project settings live in a version-controlled file at the project root and have
the same settings fields as folder settings.

## Implementation checklist

- [x] Ground the existing folder, model, target, selection, and archive behavior.
- [x] Compare settings ownership sketches and select the module boundary.
- [x] Implement the agreed settings and folder actions.
- [x] Verify migration, inheritance, grouping, repair, and browser behavior.
- [x] Review the final shape and remove superseded paths.

## Existing decisions

[ADR 0016](../adr/0016-use-real-folders-for-issue-organization.md) retains stable
folder identities and issue assignments when a folder is renamed. The
[sidebar folder design](factory-sidebar-folders.md) separates installed system
content from project-owned folders. This proposal must preserve those behaviors
or explicitly record a replacement decision.

## Current implementation

The November 18 source inspection found these constraints:

- `issue-folder-settings.mjs` recognizes `folder.md` beneath project `user/`.
  Its frontmatter requires a stable UUID `id` and accepts a description.
- Generic subfolder creation in `sidebar-files.mjs` creates a directory only.
  Issue-folder creation and migration already write the settings file.
- `flow-grouping.mjs` requires issues in the same folder, but has no branch
  compatibility check. The effective delivery destination can differ from the
  starting branch.
- New flows read the project target from `.issues/issue-delivery-config.json`.
  Model defaults and issue overrides use `.issues/model-settings.json`, with
  tracked defaults in root `factory.config.json`.
- Skills belong to individual Flow blocks. There is no issue-wide skill default.
- Selection strategies are prompts in `flow-folder-selection.mjs`. Copying a
  strategy into user Markdown needs a file format and explicit use of that copy.

The existing documents use **system** for installed Factory content. The requested
UI label **System folder** also covers ordinary project folders without settings.
Use **installed content** when describing installation ownership, to distinguish
it from the presence or absence of issue settings.

## Confirmed decisions

The user answered "yes to all" to the first interview round on November 18, 2026.

1. Include branch, skill, model, and effort in the first version. Treat search,
   filters, and selection controls as page controls rather than inherited settings.
2. Have exactly one project default issue folder. An explicit creation destination
   takes precedence. The default-folder flag does not inherit. Start with Inbox.
3. Resolve inherited values for idle issues until work starts. Save resolved values
   for a run, preserving explicit issue overrides and existing work destinations.
4. Use the folder skill as the default issue-work skill, with issue overrides and
   explicitly selected Flow block skills retaining precedence.
5. Inherit missing values, but show errors for malformed settings and invalid
   explicit values. The wand only fills absent fields and preserves identity,
   existing values, and comments.

Starting or resuming an issue reports each invalid setting with its field name,
saved value, source file, and validation reason. Issue overrides identify **Issue
settings** as their source. Model overrides on a block bypass only an invalid
inherited model; other settings still require repair. Rejected starts retain the
details in **Last blocking error** and leave earlier attempts unchanged.
The root `folder.md` is named **project settings** in errors so it cannot be
confused with the issue folder's file. Chat startup reads the main project's
configuration and storage-profile registry when an investigation or Fix Branch
runs in a temporary source snapshot. A storage profile of `default` inherits the
project's configured default. The snapshot remains the agent's working directory
and does not receive copies of local storage configuration or credentials.
`node --test scripts/factory-model-settings.check.mjs scripts/block-model-errors.check.mjs`
checks these messages and confirms that rejected Resume starts no work.
`node --test scripts/branch-repair.check.mjs` checks Fix Branch startup with an
explicit profile and with `default`.

## Second interview round decisions

The user accepted this round on November 18, 2026, with the amendments below.

1. Keep grouping within one folder. Compare each resolved PR target with the
   resolved folder target. An explicit matching target remains eligible.
2. Report zero or multiple default folders instead of choosing silently. Require
   a choice for creation without an explicit destination, and a replacement before
   deleting the current default. Existing issue assignments stay unchanged.
3. Use root `folder.md` for tracked project defaults and
   `factory/system/folder.md` as a nonconfiguring field reference. Preserve current
   project defaults during migration. Use YAML frontmatter in Markdown. Identity
   and the default-folder flag apply only to actual issue folders. All fields
   listed in the system reference apply to project defaults and missing-field
   repair. Exclude **Is default folder** from the reference and explain that
   exception in folder-file comments. Never remove existing fields when repairing.
4. Allow configured issue folders in any project-owned directory shown in the
   sidebar. Inheritance follows filesystem parents, skipping missing settings,
   and stops at the project. Installed content and outside directories stay
   browsing-only and cannot create settings through Factory.
5. Fill inheritable settings with `default`. An absent default-folder flag means
   false. New files get a new ID, but missing or duplicate IDs in existing files
   require explicit repair.
6. Show directly assigned issues in mutually exclusive Open and Closed views.
   Open is the initial view. Exclude archived issues. Put a select-all checkbox
   above the list. Search follows the folder and view. Select all selects displayed
   results. Show **Start all** in Open and **Archive all** in Closed. Closed issues
   cannot group or start.
7. AI Search sends the natural-language query and issue content through a prompt,
   finds relevant issues, and explains matches without changing records or
   selection. Ordinary Search performs text matching.
8. Copy selection strategies to unique Markdown files beneath
   `user/selection-strategies/`. Select the new copy for the current folder and
   preserve the original. Store the selected strategy as an inherited settings
   field, also documented in the system reference and covered by the wand.
9. Show a red magic wand when settings are broken, including invalid
   default-folder declarations. Repair preserves all existing fields.

The inheritance and reference-file decision is recorded in
[ADR 0018](../adr/0018-inherit-folder-settings-from-project-defaults.md).

AI Search receives every issue in the current folder's selected Open or Closed
view, including issues that are not checked and issues excluded by a previous
text search. The prompt includes the natural-language query and issue content.
It must not silently omit issues when input exceeds the model's context limit.

## Third interview round decisions

The user accepted all four recommendations on November 18, 2026.

1. A red wand explains validation errors and previews corrections. Add absent
   fields without removing existing fields. Replace invalid values with `default`
   only with explicit approval. Preserve comments and identity. Open unsafe syntax
   repairs for editing, and resolve default-folder conflicts through an explicit
   choice of default folder.
2. Bulk actions use checked rows. The top checkbox selects displayed results.
   Use **Start all** or **Archive all** when all results are checked, and
   **Start selected (N)** or **Archive selected (N)** for a subset. Disable with
   no selection. Clear selection on an Open or Closed view change.
3. Start each selected issue's saved route independently, preserving
   individual settings, eligibility checks, and confirmation stops. Preview the
   selection, skip ineligible issues with reasons, and retain individual outcomes.
   Never group automatically. Archive also previews its selection and uses the
   existing per-issue operation with visible partial failures.
4. Missing or `default` fields at the project root use Factory's built-in
   fallbacks. Show each resolved value and its source. Preserve existing project
   defaults and explicit issue overrides during migration. The system reference
   documents fallbacks without acting as settings for a folder.

Source inspection confirms that bulk archive already returns per-issue results
through `issue-storage-actions.mjs`. **Start all** is new behavior; the existing
Work All Night runner has its own finish line and does not establish the meaning
of this new control. Existing local model defaults are deliberate user preferences
and must be preserved when present in another project.

## Implementation boundary

The existing folder settings owner will handle discovery, identity, lossless YAML
edits, parent inheritance, default-folder choice, and migration. A field schema
parsed from the installed reference supplies form metadata and validation. Model
and delivery callers consume resolved values from this owner. Search and bulk
operations remain separate from settings; they call existing issue operations.

Both architecture sketches preserved stable IDs and separated display names from
filesystem paths. Extending the existing owner won over introducing a service:
both hid inheritance and validation, but the existing owner required fewer caller
changes and avoided a second lifecycle. The synthesized design keeps the other
candidate's explicit plain/configured/broken views and visible invalid entries.
Both candidates scored equally on identity preservation, settings precedence,
and lossless edits; the functional owner required a smaller public integration.
The configured cross-judge models were unavailable, so the primary agent compared
both sketches against those criteria and the documented design red flags.

Paths come from validated folder descriptors. Existing user-relative folder names
remain compatible. Other project folders use a distinct leading-slash name in
internal folder keys; neither key nor display label constructs filesystem paths.

## Verification

The implementation starts from `344c412bd96626f14f4a82532dd298244a194f20`.
Focused checks cover schema-derived fields, migration, preservation of unknown
fields and comments, revision conflicts, parent inheritance, issue overrides,
frozen execution values, grouping targets, default-folder protection, complete
AI Search input, and per-issue bulk outcomes. Existing capture, model, grouping,
and selected executor checks also passed. Archive retrieval has a dedicated check.

The focused Chrome run passed with no page errors or live model calls:
`.issues/evidence/flow-browser-aa6d94d6-d932-4771-9a71-63656a64cc90/results.json`.
It covers folder forms, repair confirmation, default selection, Open and Closed
lists, text and AI search, bulk preview and partial archive results, strategy
copying, and automatic child settings. AI responses and execution are injected;
these checks establish UI and persistence behavior, not model judgment or live
publication. Start All does not launch live issue work during browser verification.

Run `pnpm run test:folder-settings:browser` to repeat the browser check. The final
step and staged audits use `TIMEY_FALLOW_ENFORCE=1` against the starting revision.
Dynamic CSS-class warnings were checked against the actual settings markup and
browser screenshots; no selectors or audit protections were removed.
