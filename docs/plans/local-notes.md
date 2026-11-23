# Local notes

Local notes capture thoughts and todos without leaving the current work. They
have a separate **Local notes** section in the Flow sidebar. Enter saves an
inline note; Shift+Enter adds a line. **＋ Note** and Alt+N open a small editor.
Notes retain the supplied text and support editing, completion, deletion and
manual ordering. Each sidebar preview shows only the first sentence. Selecting
the preview opens the full text in the editor. The section opens expanded. Its
caret uses the same control as the sidebar folders and hides or shows the inline
form and notes without losing the draft. The quick-note button remains available
while collapsed.

The bundled `local-note` skill uses the same store through project chat tools
or the installed `scripts/local-note.mjs` command. Capturing a note starts no
issue, model turn or workflow. Project chat can select the skill through its
existing slash composer.

## Ownership and storage

The installed project owns its notes. Git worktrees resolve to the primary
worktree, so branches and worktrees share `.local-notes/notes.json`. Other
projects have separate stores. Non-Git projects use their supplied root.
The folder is excluded locally through Git's exclude file before the first
write. Already tracked notes are rejected rather than silently untracked.

An exclusive write lock protects updates from concurrent CLI and server writers;
atomic file replacement protects the saved document. Edits require the current
content basis. A stale edit is rejected with its draft retained. A capture has a
stable ID for retries. Reads start no work and create no files.

## Discussion and issue creation

**Discuss** opens a retained project conversation for the note. It saves a context
message explaining which note is being discussed, without dispatching a provider
turn. The composer contains an editable suggested first prompt. Existing drafts
and responses in other project conversations are preserved. The provider receives
the note context when the person sends a prompt. Reopening a note reuses its
conversation; edited note text refreshes the retained context.

**Turn into issue** opens the existing issue form with the note prefilled. The
person can revise the description and settings before creation. Creation uses
the ordinary issue flow and does not start its work. After creation, the note's
project conversation contains a response linking to the issue and offering
**Delete original note**. The note remains until that action is chosen, and a
retained note links back to the issue. The sidebar link includes its display
number, such as **Open issue #182**, from the project issue-number registry.
Notes keep the stable issue ID as their stored link.

## Verification

`scripts/local-notes.check.mjs` exercises storage, worktree ownership, private
Git exclusion, stale edits and quiet discussion preparation with disposable data.
`scripts/flow-browser-local-notes.mjs` drives capture, first-sentence previews,
reload, editing, completion, ordering, discussion and issue creation in the browser fixture.
Provider fixtures establish transport behavior without contacting a live model.
Human review remains useful for capture speed and layout taste.
