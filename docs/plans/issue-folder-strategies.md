# Issue folder strategies

Design agreed on November 17, 2026.

Selecting an issue folder opens it in the center column of the Flow workspace.
The folder shows its issues and the available ways to work on them. A person can
move an issue to another folder without deleting its report. Every issue must
belong to a folder.

## Strategies recommend a selection

A strategy recommends issues and explains why they fit. The person can use the
selection for a separate folder action.

**Same blast radius** selects issues that affect the same behavior or depend on
the same code. The explanation identifies the overlap and any checks the issues
could share. **Different blast radii** selects issues with limited overlap in
behavior, dependencies, and likely integration conflicts.

## Create a master issue

Select open issues with no active or uncertain work. Issues waiting for approval
and issues with previous stopped or finished attempts can join a master. Merged
issues and issues already attached to a master remain ineligible.
The **Create master issue** button sits immediately to the right of **Start all**
(or **Start selected**) and becomes available for an eligible selection of at least
two issues. It opens the combined request for review before creation.
Flow displays the **Investigate** annotation on Investigation issues.
The first selected issue determines whether the master accepts investigative or
non-investigative sub-issues. Factory creates an Investigation master for
investigative groups. Bugs and features can share a non-investigative master.
Flow explains mixed selections and blocks creation.
The folder list nests attached sub-issues beneath their master. When filtering
hides a master, its matching sub-issues remain visible as individual results.
Each selected issue's resolved PR target must match its folder's resolved default
target. An explicit issue override equal to that target remains eligible. A
different target remains visible and can run independently.
An issue can already have a clarified request. Review and edit the combined
request before creating the master. The preview links each original issue and
carries forward its requested proof and any required human checks. Start the
master as a separate action. Creating it resets the attached issues to Not started
and saves their previous states on the master. Their reports, attempts, workspaces,
and evidence remain available; their previous attempts do not determine the
attached issues' displayed status. Creating or previewing a group starts no work,
and a rejected preview changes no issue status. A retry of the same creation
finishes any remaining status updates without creating another master.

`node --test scripts/flow-grouping.check.mjs scripts/flow-folder-settings.check.mjs scripts/storage-profiles-capture.check.mjs`
checks approval and stopped issues, retained attempts, active-work rejection,
stale previews, saved status updates, and creation retries after a failed status
write. The store fixture uses the same grouping controls as the UI without
starting a model or changing live issues.

If a strategy suggested the group, save its selection reasoning on the master.
When a sub-issue's check fails, show the unmet check alongside that reasoning.
Offer **Continue on the master** and **Detach and fix separately**. Recommend the
next action based on what failed.

The original reports remain as sub-issues and cannot start independent work.
Merge requires passing proof for every attached sub-issue on the final PR
candidate. A detached sub-issue does not participate in the merge check.
Before accepting the master as Fixed, require proof for each attached sub-issue.
The Close dialog lists both attached and removed sub-issues.
Required human checks follow their sub-issues to the master and still require
the person's own observations or judgment.
Detach any issue whose request remains unmet. The user's acceptance of the master
moves the remaining sub-issues to the existing Closed state. **Fixed by** is the
closure reason, and each closed sub-issue links to the master.

When viewing a sub-issue, a row above **Issue settings** links to its master and
provides **Remove** to detach it. The row is hidden for issues without a master;
removal is unavailable while the master is active or either issue is closed.
When viewing a master, the same position shows its attached sub-issues. Each
name links to the sub-issue page, and its **Remove** button detaches it while
the master is idle. To add an eligible issue from the same folder, select it
under **Sub-issue to attach** and click **Attach sub-issue**. Flow explains a
type mismatch before submission. The server checks current types and membership
before saving an attachment or reattaching a removed sub-issue.
Requested proof and review actions appear in the inspector.
You can detach an individual sub-issue while the master is idle, including after
a partial fix. If the master closes for a reason other than Fixed, release all
attached sub-issues for independent work. Keep their reports open and link to any
relevant evidence from the master. See [acceptance through a master issue](../adr/0014-accept-sub-issues-through-the-master.md).

## Find issues to add

Choose another folder or the whole open queue as the source. Each scan considers
only unstarted issues and gives a reason for each candidate. Review is the
default. In review, deselect any candidates before moving the rest. **Auto-approve
this scan** authorizes the eligible moves from that scan alone.

**Prevent moves into folders** applies to manual moves and moves from a scan.
An issue with the restriction keeps its current folder.

## Work All Night

Show the exact issues and the finish condition before starting. Timey runs the
selection using its issue runner and pstack's [Autonomous run playbook](../../.agents/skills/poteto-mode/playbooks/autonomous-run.md).
Starting the run authorizes Factory to merge the selected issues' PRs as their
required GitHub checks pass. Factory can proceed without a GitHub review on its
own PRs when its credential can bypass the review rules and a separate active
ruleset enforces strict required checks that the credential cannot bypass.
GitHub still enforces the target rules on the exact candidate submitted for merge.
An issue that needs other human input pauses while independent work continues.
If the runner exhausts the
available repairs for an issue, leave that issue and its dependent work paused.
Continue with independent issues. A Stop control ends the run. The morning
report lists what finished and gives the failed check, where applicable, and
the next action for each issue that needs attention. Issue acceptance uses the
existing Close controls.

After a target update, closure can reuse a retained passing Work report when
the delivered candidate descends from the proved commit, preserves the implementation paths
changed by Work, and its validated verification reran all recorded Work focused
checks successfully. Required human checks still apply. Missing proof errors
include the saved sub-issue numbers when available.
