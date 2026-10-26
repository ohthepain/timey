# Factory delivery and review consistency

Implement the user's approved retrospective improvements in the factory UI source
repository, preserving the separate Timey issue queue and its closed chat issue.

1. Finalize checked delivery through one resumable owner. Retain exact source,
   tree, starting base, verification/audit summaries, requirement evidence and
   authorization. Advance Verify and Commit as completed, record integration and
   stop at Final review. Preserve custom stages and require explicit acceptance.
   Retry identical operations without duplicate history; reject changed source,
   report, evidence or operation identity. Support a delivery checkout different
   from the issue project. Native UI integration calls the same owner.
2. Identify disposable preview servers explicitly. Label their review destination
   and reject site-approval writes there; include the real project and mode in
   live approval receipts. Preserve candidate-specific review and user provenance.
3. Send summaries and a bounded selected-issue output tail when polling. Fetch
   full saved run history on demand, retaining authentication and stored history.
   Prevent overlapping refresh requests.
4. Reuse the installed `issues` skill and `factory issues` for issue lists. Extend
   factory tooling with a runtime identity query for the running UI source,
   revision, issue project and preview mode.

Verification includes separate-repository delivery, failed/stale evidence,
interruption retries, custom-stage protection, explicit acceptance, preview
approval rejection, authenticated history retrieval and a bounded polling payload.
Run the existing full verifier and required audits against the recorded baseline;
then inspect the running UI. No new issue acceptance is inferred from deployment.
