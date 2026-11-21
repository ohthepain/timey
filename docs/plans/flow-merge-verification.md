# Verification in the delivery flow

Delivery behavior for the [explicit issue flow](../adr/0013-explicit-issue-flows.md).

## Agreed local regression setting

Request will have an editable **Run full regression suite** checkbox. It defaults
to off for new issues and existing requests with no saved choice. Merge reads
the setting at the start of each attempt. Editing the setting does not change
checks already in flight.

The default local run includes the change's focused checks, all Vitest tests,
the Playwright fixture, Flow browser checks, and a small named set of Factory
checks. Relevant Factory tests can also run as focused checks. Formatting,
Fallow, type checking, and the build remain required. The full Factory suite
requires opting in. The local setting leaves existing GitHub CI and branch
protection in place.

Verify is hidden when adding blocks or generating new flow structures. Existing
Verify blocks and their retained evidence remain usable. Both Merge scopes run
each local verification command with a 15-minute deadline. A timeout stops
preparation and identifies the command in the retained result.

## The default route

The standard delivery flow goes from **Request** through **Work**, **Publish PR**, **Merge**, and **Close**. [Standard delivery definition](../../factory/system/flow/definitions/delivery.md)

- **Work** runs its own checks and records the focused commands to repeat, or records that no focused check applies.
- **Publish PR** prepares and publishes a clean committed candidate. Merge owns the independent local verification.
- **Merge** reuses evidence only for the matching candidate and destination with the focused commands and suite required for this attempt. Full evidence can cover a default attempt with the same inputs. Default evidence cannot cover a full attempt. A changed candidate requires fresh evidence before it is pushed by Merge.

## The Merge loop

Starting **Merge** authorizes preparation of the existing PR. The runner uses the issue's saved Destination and preserves the original checkout base. If the PR's base branch differs from Destination, the runner asks the user to reconcile it.

When Publish PR records the linked PR, an earlier Merge attempt that failed only because the branch had no PR moves into the attempt history. Merge is ready to run again. Newer failures and failures for other reasons stay visible.

1. Fetch the Destination. If its current revision is missing from the issue branch, merge that revision into the issue branch.
2. Run independent local verification if the issue commit changed or lacks valid evidence. Push a new verified commit to the existing PR so GitHub can run its required checks.
3. Wait for GitHub to report readiness for the current PR commit. Fetch the Destination again before merging. If it advanced, repeat from step 1.
4. Once the issue commit and target revision are current and GitHub reports the PR ready, apply the merge policy. Automatic policy can proceed through GitHub's protected merge. Human-first policy asks for approval of the exact PR commit and target revision. A change to either revision expires that approval and returns the run to preparation.

Merge can resolve straightforward conflicts and repair verification failures within the approved issue scope. It retries after a concrete repair or a target update. It pauses and reports the blocker when progress stalls or a decision, additional permission, or broader scope is required. Each attempt retains its verification evidence and outcomes.

A required GitHub review is shown as **Needs your input**, with instructions to
obtain approval from an eligible reviewer, a **Review PR** link, and **Continue**.
The request appears below the issue banner, on Merge, and beside the issue in the
sidebar. It survives reloads. Continue starts an explicit attempt that rechecks
the current PR, candidate, target and required checks; it retains reusable
verification. A review being approved externally never resumes work by itself.
Other failures retain their failure presentation and Retry action.

## Markdown definitions

The delivery flow Markdown defines the default block order. The **Merge** block Markdown declares the loop and stop conditions as settings the runner executes. The runner enforces the saved Destination, exact-commit verification, GitHub protection, and the applicable approval. [Merge block definition](../../factory/system/flow/blocks/merge.md)

GitHub's merge request pins the PR commit. The runner rechecks the target just before the request. GitHub's target branch protection applies during the request.
