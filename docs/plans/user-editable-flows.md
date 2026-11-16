# User-editable flows

Design for the [explicit flow workspace](../adr/0013-explicit-issue-flows.md).

## Definitions and defaults

Each flow definition is a Markdown file with a stable ID, display name,
allowed issue types, and an ordered block list. A definition can also supply
a prompt or skill for building the flow. Each entry in the list has a stable
block key and names a block definition. Request is the required first block.
Starting point and Destination read the issue flow's saved branch settings.
For this design, branches are
independent paths that can run in parallel. The paths have no join. Branch
scheduling is deferred.

The Factory package ships its own flow definitions and a `defaults.md` that
maps each issue type to a flow ID. The team commits custom flow definitions
and extensions to project-owned directories in Git. Package updates replace
the bundled files and keep the team files available.

The `extension` field in the frontmatter names an optional Markdown file by
its full path from the project root. The loader reads the base file first
and the project file second. An extension's `blocks` list replaces the base
list. For default mappings, the project
entries take precedence for the issue types they name. Types omitted by the
project extension use the current package defaults. Each mapping must point
to a flow that supports that issue type.

For flow builder instructions, the builder receives the base `# Prompt` before
the appended project text. The builder can add, remove, and reorder blocks
after Request. The appended text can tell the builder which
earlier instructions to disregard. For example, it could say "Disregard the
earlier choice of review skill. Use the project's review skill." Both texts
remain part of the builder input. Factory still checks
the generated block list and applies the usual execution rules.

## Build or update an issue flow

When an issue is created or its type changes, select the default flow for that
type and build the structure. The user can choose another eligible flow from
the picker. When a definition supplies a prompt or skill, the builder runs it
once per build. Otherwise, the builder uses the block list as written.
Subsequent block runs use their own instructions.

Keep the saved blocks and attempts in the existing issue flow record. Record
the flow ID, its display name, and a checksum of the applied definition, including the appended
content that affects the build. Calculate the checksum from parsed content.
Ignore extra whitespace, line wrapping, and decorative formatting. Preserve
meaningful differences such as changed words, block order, and indentation
inside code.

The checksum identifies the version of the linked Markdown definition. Edits
to an issue's block list leave that checksum as saved. To detect a Markdown
update, compare the saved checksum with the current definition's checksum.

Markdown edits affect the next build. For an open issue, click the
**Rebuild flow** wand to recreate the structure from the linked Markdown.
The issue title area shows the type and progress followed by the **Flow**
button and wand. The **Flow** menu lists eligible flows and offers
**Reveal in Finder** for the linked Markdown file.

## Edit and export an issue flow

The user can add, remove, or reorder blocks in an issue. These edits affect
only that issue. Rebuilding uses the selected flow definition and discards
issue-specific changes to the block list.

Choose **Save as user flow** to save the current block list as a new Markdown
definition in the project's custom flows folder. The export includes
references to block definitions, stable block keys, their order, and branch
dependencies. Attempts, artifacts, and issue-specific inputs stay with the issue.
An exported definition consists of the saved block structure and catalog fields
such as its name and allowed issue types. A later rebuild uses that block list
exactly as saved.

After the file is saved, link its flow ID, display name, and checksum in place.
The issue keeps its current blocks and progress. **Reveal in Finder** locates the
new file. The exported definition is available to other eligible issues and can
be committed to Git for the team.

## Keep progress when the structure changes

Keep the attempts, artifacts, and completion of blocks that carry forward.
Retain the history of removed blocks and start newly added blocks without
attempts. Changing the issue type, choosing a different flow, and applying
Markdown edits preserve prior progress. Building a structure starts none of
its blocks.

Resetting progress is a separate user decision. One option is to rerun the
first affected block and mark its dependent blocks for rerun, while retaining
their earlier attempts. The rerun behavior is still open.
