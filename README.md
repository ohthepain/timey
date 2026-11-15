# Timey

## Build and run locally

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

Use pnpm and `pnpm-lock.yaml`; `.nvmrc` pins the local Node runtime. `package.json` `packageManager` pins the pnpm version. If Corepack rejects that pnpm release with a signature error, update Corepack (`npm install -g corepack@latest`) and activate the pinned version.
Run `pnpm run hooks:install` once per checkout to enable the staged Fallow audit.
Run `pnpm run verify` for isolated checks and evidence under `.issues/evidence/`.
Existing typecheck failures remain visible; see [verification](docs/agents/verification.md).

Invoke `$factory` in Codex to evaluate the local queue and recommend actions.
Launches are separate: `$factory launch ACTION_ID`. Evaluating the queue never
launches workers or starts another iteration. See [operating rules](docs/agents/operating.md).
Use `$factory integrate ACTION_ID` to explicitly finalize a completed worker's
code under its saved merge policy; this is separate from queue evaluation.

The [authentication foundation setup](AUTH_SETUP.md) documents Better Auth,
separate auth/domain ownership, migrations and the disposable PostgreSQL/HTTP proof.

## Edit the Factory UI from Markdown

Factory displays block-specific Markdown in **Details** and uses the first
paragraph as the card summary until the block has instructions or a run result.
The card layout, title, status, and action controls come from the shared Flow UI.

### Find and edit the source

1. Turn on **Inspect UI**. Hover or focus a tab to see its bundled Markdown
   file, section, and active project override. **Inherited** means the tab
   uses the bundled default. Controls outside this slice report that the
   runtime owns them.
2. Right-click, press and hold, or press Shift+F10 to open the source menu. For
   example, opening the menu on **Start** does not start work.
3. Choose **Edit override** or **Create override**. In the editor panel, change
   only the section or field you want to customize.
4. Choose **Save and reload**. The label updates in place. If the build finds
   an error, the last working UI stays active. If the source changed on disk
   while you edited, the editor keeps your draft and shows the conflict.

### Edit from a text editor or with an agent

1. Run `pnpm run factory ui find Details` from the project root to find a label,
   screen, or section. Run `pnpm run factory ui index` to list all editable
   sections. Both commands show the bundled file, project override, and regions
   that use the section.
2. Edit the named section in the project override. Keep unrelated sections in
   the bundled default. For example, add the heading `## details-tab` and put
   the new label on a separate line in `factory/ui/overrides/flow/block-inspector.md`.
   Follow the project's formatting rules for Markdown and code.
3. Run `pnpm run factory ui update` to validate a fresh build. Use
   `pnpm run factory ui update --watch` to report which regions rebuild as you
   edit. An open flow workspace picks up valid changes without a page reload.

### Change a block's content

Open a block and choose **Create override** to copy its bundled Markdown.
**Show in Finder** reveals the project file so you can edit it in your own
editor. Create a new Markdown file in `factory/ui/overrides/flow/blocks/` to
add a custom block. Pick an installed skill in the block editor, or run the
block using its Markdown prompt alone. To adapt a skill, paste and edit its
instructions in the Markdown.

Use these headings in a block definition:

| Heading           | Content                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `# System prompt` | Instructions and evidence expectations for the block. Native operations continue to apply their existing guards.                                                                                                         |
| `# Details`       | A table with columns **Key**, **Source**, **Label**, and optional **Default**. Sources include `editable`, `derived`, `issue.title`, `issue.content`, and upstream artifact names such as `Request.goal` or `candidate`. |
| `# Artifacts`     | A table with columns **Key**, **Kind**, and **Label**. Use `value` for structured data or `file` for a retained file.                                                                                                    |

See [the Work definition](scripts/factory-ui/views/flow/blocks/work.md) for an
example. An override can supply just the sections it changes. Opening or running
a block, or clicking its wand, checks for changes to that definition. A change
stops active work in each affected flow and makes the edited block and its
connected successors stale. The old attempts and artifacts remain visible.
Saving **Your words** or clicking the Request wand also reruns clarification.
Choose **Rebuild flow** when you want to apply the clarified issue type to the
route.

### Set block defaults

Built-in settings live in
[the block catalog](scripts/factory-ui/views/flow/blocks/catalog.json). To select
Arena on newly created Work blocks, put this in
`factory/ui/overrides/flow/blocks/catalog.json`:

```json
{
  "work": {
    "defaultSkill": "arena"
  }
}
```

The catalog also accepts `label`, `color`, and `order`. Saved
blocks keep their selected skill when a default changes. A new Markdown filename
adds a project block that uses the Work operation. Add a catalog entry to set
its label or default skill.

### Change the skill list or append project notes

The bundled block's `# Skill list` heading supplies the suggested skills. To
replace Work's suggestions, add this to `factory/ui/overrides/flow/blocks/work.md`:

```markdown
# Skill list

- arena
- how
```

You can put this section in a file by itself. Factory then keeps the bundled
prose. Omit the section to inherit the bundled list, or leave the section empty
to clear the suggestions. **Refresh skills** can still list other installed
skills. The list does not select a default skill.

To append Work notes, create `factory/ui/extensions/flow/blocks/work.md`.
The bundled block's `# User extensions` section names the matching file.
Factory renders it under **User extensions** in **Details**. The extensions
folder mirrors the bundled `views/` tree, so each block keeps the same relative
path and filename. Project-defined blocks can opt in by putting their filename
under `# User extensions` in their block document.

If you already use `factory/ui/overrides/flow/blocks/work_user.md`, you can move
it to the new path. Factory uses the old file when the new file is absent.

### Check an override before you use it

The builder checks the block documents and the effective tab labels with your
overrides. If you see a diagnostic, use the reported file and section to fix
the source. Remove an override section to use its bundled label again.

Use a test issue to check workflow controls with the default and the override.
For example, inspect and reload the block inspector. Confirm that zero blocks
start. Then turn off **Inspect UI** and confirm that an explicit **Start** click
starts one block.

## Issues

The repo currently tracks issues localling using skills from the local-issues-skills project.

## Data structures

Beat - contains notes and timing
MidiService

- Outputs midi pulses and midi notes
  BeatRecorder - creates a performance and performanceFeedback
- beat
- tempoService_midiPulse
- midiService_midiNote
