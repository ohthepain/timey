# Verification in the delivery flow

Delivery behavior for the [explicit issue flow](../adr/0013-explicit-issue-flows.md).

## The default route

The standard delivery flow goes from **Request** through **Work**, **Publish PR**, **Merge**, and **Close**. **Verify** remains available as a standalone block for an explicit checkpoint. [Standard delivery definition](../../factory/system/flow/definitions/delivery.md)

- **Work** runs its own checks and repairs failures within the approved issue scope.
- **Publish PR** reuses valid independent Verify evidence for the exact issue commit. If the evidence is missing or stale, Publish PR runs the independent checks and records the result before pushing.
- **Merge** reuses valid independent evidence while the issue commit is unchanged. A new commit needs fresh evidence before Merge pushes it to the existing PR.

## The Merge loop

Starting **Merge** authorizes preparation of the existing PR. The runner uses the issue's saved Destination and preserves the original checkout base. If the PR's base branch differs from Destination, the runner asks the user to reconcile it.

1. Fetch the Destination. If its current revision is missing from the issue branch, merge that revision into the issue branch.
2. Run independent local verification if the issue commit changed or lacks valid evidence. Push a new verified commit to the existing PR so GitHub can run its required checks.
3. Wait for GitHub to report readiness for the current PR commit. Fetch the Destination again before merging. If it advanced, repeat from step 1.
4. Once the issue commit and target revision are current and GitHub reports the PR ready, apply the merge policy. Automatic policy can proceed through GitHub's protected merge. Human-first policy asks for approval of the exact PR commit and target revision. A change to either revision expires that approval and returns the run to preparation.

Merge can resolve straightforward conflicts and repair verification failures within the approved issue scope. It retries after a concrete repair or a target update. It pauses and reports the blocker when progress stalls or a decision, additional permission, or broader scope is required. Each attempt retains its verification evidence and outcomes.

## Markdown definitions

The delivery flow Markdown defines the default block order. The **Merge** block Markdown declares the loop and stop conditions as settings the runner executes. The runner enforces the saved Destination, exact-commit verification, GitHub protection, and the applicable approval. [Merge block definition](../../factory/system/flow/blocks/merge.md)

GitHub's merge request pins the PR commit. The runner rechecks the target just before the request. GitHub's target branch protection applies during the request.
