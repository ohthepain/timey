# End default factory work at a draft PR handoff

The factory's default outcome is one draft PR per issue for manual repair and
merge. This supersedes ADR 0004's default requirement to publish only a complete,
passing issue. Its provider identity, durable operation recovery and conditional
merge restrictions remain valid for explicitly selected verified delivery.

Integration, final review and closure default to skip for new issues and undecided
routes. Preserve explicit take/skip decisions, existing PRs and running worker
assignments. A skipped closure role never closes the issue or implies acceptance.

Implement within the approved plan, attempt relevant checks once per changed
candidate, retain actual failures and unavailable checks, and publish partial work
with its remaining obligations disclosed. Publication still requires the exact
branch approval. Clean source, contribution identity and durable recovery protect
what is published; check success and target mergeability do not gate handoff.

After publication, record the manual handoff and finish Progress. Automatic repair,
rebase, CI maintenance, merge, final review and closure stop. The person decides
when to repair and merge, or explicitly requests another factory assignment.
