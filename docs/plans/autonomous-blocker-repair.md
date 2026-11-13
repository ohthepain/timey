# Autonomous issue blocker repair

## Approved behavior

Confirmed on 2026-11-02 after grilling: an explicitly started Full Stop or Full
Send run owns necessary blocker repairs, including inherited failures outside the
original feature. This supersedes the strategy's stop-on-unrelated-failure rule.
It grants no unrelated improvements, product decisions, destructive changes,
deployment, protection bypass, human acceptance or issue closure.

Fetch and merge the configured target into the saved issue branch, preserving
work and resolving conflicts. Keep the original comparison base. Return real
verification, CI and readiness failures to the same owning chat; verify each
changed candidate independently. Enforce Fallow and repair new findings including
warnings. Never weaken tests, suppress findings, add exclusions or move the base
to manufacture a pass.

Keep separate repair commits on the issue PR. If it already merged and a repair
is needed, retain that PR and prepare a linked follow-up branch/PR under the same
delivery strategy. Reconcile an already merged, verified result without opening
another PR or repeating implementation.

Each explicit Start/Continue allows three materially different approaches to the
same blocker. Save the failure, source revisions, reported approach and actual
evidence paths before another attempt. Repeating an approach or returning an
unchanged candidate stops; unchanged verification is not repeatedly run. A new
explicit Continue renews the bounded attempts while retaining their history.
Temporary infrastructure failures allow three delayed retries. Permission denials,
uncertain writes/protocol results and genuine human decisions stop immediately.
Observe pending CI without consuming a code-repair attempt. A merge retry must
first reconcile whether the original request actually merged the PR.

New work and existing issues on their next explicit Continue receive the new
policy receipt. Inactive work never revives in the background. Sol Loop retains
its separately authorized budget and its approval is bound to the reviewed head.
Fixed closure still requires passing verification and explicit human acceptance.

## Verification

Exercise repair through the real strategy controller and disposable repositories:
initial implementation followed by failed verification and a successful repair;
readiness conflicts; three failed approaches; repeated approaches; unchanged
source; stop/pause; explicit permission denial; bounded infrastructure retries;
target fetch/merge and preserved conflicts; and follow-up repair after a merged PR.
Validate that strict audit evidence cannot reuse skipped Fallow or passing warning
verdicts. Preserve Full Stop's no-merge boundary and Full Send's protected merge.
The server must retain successful checks even if later delivery fails, and closure
must remain a deterministic acceptance of retained evidence.
