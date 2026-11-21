---
name: local-note
description: Save quick project-local notes or todos without interrupting the current task; list, edit, complete, reorder, or delete them when asked.
---

# Local note

Save the person's words immediately with the `local_note` tool, using action
`create` and the supplied text. Give a brief saved acknowledgment and continue
the existing task. Capture requires no interview or rewriting.

Use `local_notes` to read notes and their current basis before editing, completing,
moving or deleting a selected note. Pass that basis to `local_note`; refresh
after a stale-edit rejection rather than overwriting another capture.

Outside the project chat, run the installed Factory's `scripts/local-note.mjs`
from the owning project's working directory. Use `add TEXT`, `list`,
`edit ID TEXT`, `done ID`, `reopen ID`, `up ID`, `down ID`, or `delete ID`.
Resolve the script relative to this skill's installation, four directories up.
Quote note text as a shell argument so its contents remain literal.

Notes belong to the installed project, including its Git worktrees, and stay in
its ignored `.local-notes/` folder. The shared issue queue is separate.

When the person wants to discuss a note, use its **Discuss** action: it prepares
the project chat with the note and an editable suggested first prompt, without
starting a reply. **Turn into issue** prefills issue creation and continues the
discussion. Once created, link to the new issue and offer to delete the original
note. Retain it until the person chooses deletion. Creation starts no issue work.
