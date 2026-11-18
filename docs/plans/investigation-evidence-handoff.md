# Investigation evidence handoff

The failed Understand attempt for issue `20261117T155959204-a2ce99d9b32bfe6f`
reported that the publication records, candidate revisions, and writable proof
destination were unavailable. The coordinator retained the original attempts in
source issue `20261117T134253112-3d06c13a1836773c`; the issue checkout did not contain
that queue history.

## Reproduced failures

Focused tests first failed on three independent boundaries:

- `issue.title` and `issue.content` in the Details table resolved to empty manual
  inputs. They now resolve to the current report as fixed inputs.
- Retro follow-ups lost the source issue ID. Capture now records `source_issue`,
  and subsequent model turns receive a sanitized snapshot of that report and its
  attempts from coordinator storage. The snapshot is retained with a digest.
- The read-only Understand prompt requested saved proof without explaining the
  automatic Block response artifact. Runtime instructions now explain retention
  on every turn, including resumed chats. Filesystem permissions remain read-only.

A fake GitHub CLI also reproduced loss of the 422 validation body. The provider
now keeps bounded message and validation-error fields while stripping credentials
and raw process diagnostics. Publication retains this sanitized response with the
proposed head and destination even if the branch push already succeeded. A 422 is
not an infrastructure retry and asks the operator to review validation first.

## Recovered historical evidence

The original attempts were recorded at 14:00:20, 15:30:20, and 15:35:01 UTC on
November 17, 2026. Their selected Work candidate was `4bf0c44`; the first pushed
that revision, while the last recorded pushed head `8cbf3fe`. The middle attempt
did not retain a pushed-head result. The local recovery is saved under
`.issues/evidence/issue-147-diagnosis-20261118/`.

Both pushed heads are ancestors of the current `number_2`. That current comparison
does not establish the destination revision at the time of each request. The raw
historical GitHub response bodies were discarded, so the exact 422 validation
reason remains unknown. No response was fabricated, no publication retried, and
the original blocked attempt remains in history. The existing follow-up is now
linked to its actual source issue for the next explicitly requested run.

## Verification

The new tests failed before the fixes and passed afterward. The full executor,
delivery, and provider diagnostics checks passed, along with focused Flow and
GitHub App checks. These use disposable repositories and a fake GitHub CLI, with
no live model or GitHub publication. The enforced step audit uses starting commit
`1fdba6f4f405b8128c90f1b75936d46009900f62`.

The broader Flow selection passed 22 of 23 checks. The parallel-lane publication
ordering check also fails with the same assertion on an exported copy of the
unchanged starting commit. It remains an inherited failure, outside this repair.
The executor, delivery, and provider diagnostics suites passed all 84 checks;
GitHub App checks passed both cases. No check was weakened or suppressed.
