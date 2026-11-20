# Factory sidebar folders

The sidebar, project Markdown editing, and issue folder migration are in the
working implementation. **Open** still reads the flat `.issues/` queue. Moving
open reports requires a coordinated update to the pinned issue helpers and the
shared queue writer. The Git tracking example below is for that new layout.

## Project ownership

The project using Factory owns the project folders in the sidebar. The sidebar
opens specific folders within that project. It does not show the project root.

Factory already accepts a project path when it starts. It reads issue records,
custom flows, and overrides from that project. It reads the built-in flows and
blocks from the Factory installation. Timey can currently serve as both the
installation and the selected project.

## Accepted design

Show the system folders from the Factory installation. The selected project has
a `user/` directory that mirrors the system layout. For example, installed
`flow/` and `skills/` have project counterparts at `user/flow/` and
`user/skills/`. Setup references the installed Markdown. A user can explicitly
copy a built-in flow into the project. See
[ADR 0015](../adr/0015-reference-installed-factory-content.md).

Use explicit flow references for extensions and overrides. A matching file name
under `user/` has no effect on the built-in flow. Make `user/skills/` available
through Factory's existing Codex skill discovery so files shown there can be
used as project skills. **Install project skill** registers a
`user/skills/<name>/SKILL.md` file with Codex.

Show one **Issues** entry for the selected project's `.issues` storage, with
**Open**, **Closed**, and **Archived** backed by `.issues/open/`,
`.issues/closed/`, and `.issues/archive/` respectively. An issue folder such as
`user/Releases/` displays assigned issues from the queue alongside files such as
`checklist.md`.

List open issue folders directly under **Issues** with expandable members and counts.
Selecting the folder opens its existing issue actions. Drag issues between
folder headings to change assignments. Every issue belongs to a folder. The Files tree
continues to browse the folders' Markdown.

Show real folders in one tree. A project folder with a `folder.md` settings file
can show its Markdown, assigned issues, and issue actions in the same sidebar
entry. Call it an **Issue folder**. Reports stay in the queue. For example,
`Releases/` can hold `checklist.md` and show issues assigned to Releases. See
[ADR 0016](../adr/0016-use-real-folders-for-issue-organization.md).

## Settings and membership

The [folder settings design](folder-settings.md) and
[ADR 0018](../adr/0018-inherit-folder-settings-from-project-defaults.md) define
inherited settings, the project default issue folder, validation, and repair.

Creation requires an existing folder. A move always names another folder.
Older reports without a saved assignment belong to **Inbox** until migration
saves that assignment on their report. The Inbox directory has its own
`folder.md`. Migration also covers retained Closed and Archived reports.

Keep `folder.md` with the project files. Store each folder assignment with its
issue report. Shared queues use the existing report publication path so users
with the same folder settings and shared queue see the same assignments.

The settings file carries a stable folder ID, optional description, and inherited
settings defined by the installed reference. Root `folder.md` supplies tracked
project defaults. The default-folder flag belongs to a single issue folder and
never inherits. The
directory name appears in the sidebar. A rename or move within the project
preserves assignments. Give a copy a new ID before it can accept assignments.
If the original folder is missing, retain its assignments so restoring the
folder restores its issue view. People choose existing issue actions explicitly.

## File access

Users can create project subfolders with a plus icon on each writable folder
row and edit existing project Markdown in Factory. Built-in Markdown opens for reading and can be copied to
the project for editing.

System and issue folder rows use the same disclosure triangle, font, color,
and spacing. Issue folder names are italic. Names open a landing page and
triangles expand the contents. A file folder without settings shows its name,
**System folder**, and **Create folder.md** when project-owned. Finder and Delete
use adjacent icon buttons. After confirmation, deletion moves the actual directory
and its contents to macOS Trash. A directory with assigned issues, including
issues in its subfolders, must be emptied of those assignments first. The current
default issue folder requires a replacement before deletion.

Add outside folders for browsing in place. Show Markdown in its real subfolders
and offer **Open in editor**. Enable issue features only inside the selected
project. Outside `folder.md` files open as ordinary Markdown.

## Git tracking

In a project that uses normal Git commits for reports, set tracking per lifecycle
directory in the project's `.gitignore`. For example, these rules make Closed
reports eligible to stage while keeping Open and Archived reports ignored:

```gitignore
/.issues/*
!/.issues/closed/
```

Keep the project's existing exceptions for queue policy files. Changing an
ignore rule affects untracked files. Removing reports from future commits also
requires removing already tracked reports from the Git index while keeping the
local files. Past commits still contain the reports.

Shared queue mode publishes Open and Closed reports through its existing report
writer and keeps Archived reports local. The ordinary `.gitignore` rules govern
staging in the project checkout. The shared writer's report allowlist governs
publication to the queue branch. See
[ADR 0017](../adr/0017-track-issue-lifecycle-folders-separately.md).

## Migration

Move Timey's existing folders directly and preserve settings and assignments.
Move open reports to `.issues/open/` while preserving report IDs and display
numbers. Update queue readers, writers, links and the shared queue allowlist for
the new path. Exercise the move against a copy of the queue before changing live
data. The current installation needs no customer-facing migration preview.

## Verification

Run Factory from its installation against a separate project. Check the system
and user trees, file edits, explicit flow overrides, and project skill discovery.
Exercise directory drop and the folder creation plus icons in the supported browser. Verify that
external `folder.md` files open as documents. Rename, copy, remove and restore an
issue folder and confirm assignments follow its identity. Check report migration,
closure, archive, restore, and shared membership in separate queue checkouts.
