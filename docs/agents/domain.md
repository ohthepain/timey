# Domain documentation

Use a single-context layout:

- `GLOSSARY.md`: agreed domain terminology.
- `docs/adr/NNNN-short-title.md`: architecture decisions.
- `docs/plans/`: specs and implementation plans.
- [Codebase map](codebase.md): concepts, responsibilities, and implementation boundaries.

Read the [verification guide](verification.md) before exercising changes, and the
[operating guide](operating.md) before coordinating or delegating work.

Before exploring, read the glossary and ADRs relevant to the work.
If absent, proceed; create them when terminology or decisions are resolved.

Use glossary terms consistently in reports, code, and tests.
Surface conflicts with existing ADRs explicitly.
Keep issue progress and verification in the corresponding `.issues/` report.

When code changes affect documented concepts, boundaries, decisions, or workflows,
update the affected docs and repair their pointers in the same change. Remove
stale guidance. Keep implementation navigation in the codebase map and domain
definitions in the glossary; link between them instead of repeating content.

Before finishing changes, use the containing project's documented formatter,
lint, and static-analysis commands at their required scope. Run them after the
last edit in the checkout being handed back, including after copying changes
from another worktree. Fix failures introduced by your changes and rerun affected
checks after further edits. Report any checks that still fail or could not run.
