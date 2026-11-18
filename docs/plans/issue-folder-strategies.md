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

Select open issues that have no active run and have not started implementation.
Each selected issue's resolved PR target must match its folder's resolved default
target. An explicit issue override equal to that target remains eligible. A
different target remains visible and can run independently.
An issue can already have a clarified request. Review and edit the combined
request before creating the master. The preview links each original issue and
carries forward its requested proof and any required human checks. Start the
master as a separate action.

If a strategy suggested the group, save its selection reasoning on the master.
When a sub-issue's check fails, show the unmet check alongside that reasoning.
Offer **Continue on the master** and **Detach and fix separately**. Recommend the
next action based on what failed.

The original reports remain as sub-issues and cannot start independent work.
Before accepting the master as Fixed, require proof for each attached sub-issue.
Required human checks follow their sub-issues to the master and still require
the person's own observations or judgment.
Detach any issue whose request remains unmet. The user's acceptance of the master
moves the remaining sub-issues to the existing Closed state. **Fixed by** is the
closure reason, and each closed sub-issue links to the master.

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
The default finish line is verified, merge-ready PRs. An issue that needs human
input pauses while independent work continues. If the runner exhausts the
available repairs for an issue, leave that issue and its dependent work paused.
Continue with independent issues. A Stop control ends the run. The morning
report lists what finished and gives the failed check, where applicable, and
the next action for each issue that needs attention. Merge and closure remain
separate actions.
