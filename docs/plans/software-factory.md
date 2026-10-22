# Software factory: discovery brief

Status: discovery. This records the user's stated goals and open decisions;
it does not authorize an implementation architecture or rollout.

## Stated goals

“Modern” refers to the codebase and its engineering environment. The aim is a
software factory where coordinator agents can drive work forward, adjust plans,
coordinate execution, and improve the process using retrospective evidence,
with less user micromanagement.

- Give agents “hands and eyes”: usable tools to act and inspect outcomes.
- Use verification as the basis for trust.
- Reduce reliance on conversation compaction by preserving meaningful,
  maintainable knowledge in the codebase.
- Keep documentation simple, navigable, and aligned with expectations.
- Reuse existing tools and conventions before building replacements.
- Establish clear standards and routine tool use; the user specifically named
  running Fallow against the diff before finishing a commit. Its exact tool
  interface and the intended gate remain to be established.
- Use tutorials and prototypes to make grilling concrete and improve decisions.
- Enable coordinators to understand the code directly; documentation should
  capture intent and decisions rather than duplicate readily discoverable code.

## Existing decisions

Use the local `.issues/` queue for tracking. The tracker adapter and domain
conventions live in `docs/agents/`. Local lifecycle states and optional Matt
Pocock triage classifications are separate.

## Open decisions

- First delivery scope and the observable success criterion.
- Coordinator authority, escalation boundaries, and commit policy.
- Evidence required for completion, including unavailable device/manual checks.
- What retrospective changes may be applied autonomously.
- Triggers for tutorials and prototypes.
- Minimum useful documentation, tooling gaps, and implementation sequence,
  informed by repository inspection.

Resolve these through grilling before implementing the operating model. Add
agreed decisions here as they emerge. Reserve the domain glossary for Timey's
domain terms rather than general engineering process vocabulary.
