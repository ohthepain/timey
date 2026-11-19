# Fix the Branch

Status: proposed execution design. The block definition is available to the
catalogue. A standalone project action and automatic project-check configuration
are not implemented.

Project checks can prevent implementation or collection of requested proof. A
missing-proof message must retain the check failure that caused it. Fix the Branch
repairs those prerequisites without running delivery verification.

## One procedure, two entry points

The procedure lives in
[`factory/system/flow/blocks/fix-the-branch.md`](../../factory/system/flow/blocks/fix-the-branch.md).
It uses the existing block prompt and optional skill selection. It needs no
duplicate skill containing the same instructions.

An optional block lets users include repair in their issue flows. It operates on
the saved issue checkout. It does not repair the shared starting branch directly.
Users can extend its prompt and skill list through
`user/flow/extensions/blocks/fix-the-branch.md`.

A proposed **Fix the Branch** action on Project home runs the same block without
creating an issue. The person selects the branch. The run retains its own history,
check commands, comparison revision, starting commit, repair commits, and logs.
Use an isolated repair checkout so concurrent issue work cannot share its writes.
Publication follows the project's normal delivery controls as a separate action.
Repairing that checkout alone does not mark the original branch healthy.

## Project checks

Reuse commands defined by the project's scripts and verification instructions.
The block has editable Details for blocking commands and their comparison
revision. Project extensions can document the defaults while a shared project
configuration contract is designed. Do not add credentials or skill installation
requirements to this configuration.

For Timey, the existing `node scripts/verify.mjs --work-checks --write-format
--base <revision>` command runs changed-file formatting and strict Fallow before
focused tests. It does not run the full test suite. Its comparison revision is
part of the check's meaning. Comparing a clean branch to itself invokes Fallow's
all-findings gate, while comparing an issue to its saved base scopes findings to
the issue changes. Select the intended scope explicitly. A formatting command may
also change files, so it belongs inside the repair checkout.

Passing prerequisite checks means implementation can start at the checked
revision. It does not replace focused tests, requested proof, CI, or merge checks.
Results become stale when the checked source or check configuration changes.

## Failure reporting

Show the check failure before its downstream consequence. Retain the command,
revision, exit result, diagnostic, and log. Distinguish an inherited branch failure
from a finding introduced by the issue. A missing proof artifact alone does not
establish which kind occurred.

The block prompt now requests this report. General Work failure presentation
still needs runtime support if Factory is to display check failures consistently
without relying on the model's wording. A failed prerequisite must not start
branch repair, retry an issue, or change its route automatically.
