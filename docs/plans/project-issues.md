# Project Issues tab

This design was confirmed on 2026-11-19. It adds an **Issues** tab between
**Home** and **Discuss**; **Admin** remains after Discuss. The Add menu remains a
separate action. The tab provides a project-wide workspace for comparing and
prioritizing issues across real issue folders. It does not change where reports are
stored or how code and issue reports are version controlled.

## Shared issue workspace

The project Issues tab and a real issue folder open the same three-column
workspace:

1. Project navigation and issue folders on the left.
2. A filterable issue list in the middle.
3. The selected issue's Request block view on the right, using the same
   responsive width as the Flow block inspector. The detail column can be
   resized independently.

The project-wide issue list loads when its tab is first opened. Request embeds
do not start a second, hidden issue list. Investigation issues keep their Request
visible in the detail column instead of switching to the full investigation page.
Request embeds use a selected-issue view that skips building the full project
index and branch catalog. Flow actions continue through the existing revision
and destination checks.

The project Issues view lists open issues across folders by default. Closed
issues can be viewed through the existing lifecycle filtering; Archived issues
remain in the Archive view. The list shows each issue's folder and priority.
Priority is visible and sortable, but the list does not edit issue fields inline.
The project's existing issue search, lifecycle filters, and ordering controls
remain available.

In the project Issues tab, checkboxes replace the issue-list drag handles. The
checkbox at the top selects all issues currently visible through search and
filters. When sorting by implementation order, dragging anywhere on an issue row
reorders the implementation order. The existing project navigation and folder
column stay visible. Clicking an issue row opens its Request view without
changing checkbox selection; only clicking a checkbox changes selection.
Selecting the **Issues** heading opens the Issues tab.

A real issue folder uses this same workspace with the list scoped to that folder.
Folder-specific controls such as choosing the default issue folder or finding
issues to add do not appear in the project-wide Issues view.

## Selecting and editing issues

Tapping an issue in the middle list opens its Request block view in the right
column at the narrower workspace width. Request includes a Merge branch control
for the issue's destination branch. The right column can be resized. When no
issue is open or checked, the right column and resize handle are hidden and the
issue list fills the available width.
A separate checkbox supports multi-selection. When one or more issues are
checked, the right column switches to a shared bulk editor and shows the number
selected, including when exactly one issue is checked. The issue list remains
available while editing.

The bulk editor offers folder, priority, target branch, reusable, and retro
settings. Target branch means the destination branch for the issue's pull
request. Reusable is available only when every selected issue is an
investigation. Other issue-specific detail and workflow fields stay hidden in
bulk mode. If selected issues have different values for a field, show **Mixed**.
Save applies only fields the person changed, across the entire selection.

Target branch can be changed only when every selected issue is eligible. If any
selected issue has a locked destination, disable that field and explain why
instead of applying it to only part of the selection.

Selections remain active when filtering hides selected issues, and the selection
count stays visible. **Select all** applies only to currently visible filtered
issues. Bulk saves report an outcome for each issue. Successful updates remain
saved if another issue fails; failed issues remain selected for retry.

## Scope

This design changes the project navigation and issue workspace presentation. It
does not move reports out of `.issues/`, combine report and code commits, alter
the shared queue publication model, or replace the existing issue detail and
workflow controls.
