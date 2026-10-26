# Review standards

Read the applicable domain and verification guides through [the agent guide](AGENTS.md).
Use automated checks for mechanical rules. Review the following semantic decisions
when changing workflow gates, freshness checks or acceptance behavior.

## Workflow gates

For every changed gate, identify the operation it protects, the selected issue or
candidate, the evidence required and the changes that make that evidence unusable.
Assess whether that scope matches the user's intended operation across both legacy
records and current records. Explain any queue-wide or whole-checkout dependency.

Accepting a recorded result preserves its original revision, proof and limitations.
Verifying or delivering current source requires evidence for that current candidate.
Review these separately: a later unrelated commit must not turn historical acceptance
into a demand to verify all current work. Changed selected requirements, altered proof,
missing observations and active work on that issue still need explicit handling.

Require positive and negative compatibility cases from
[the workflow verification contract](docs/agents/verification.md#workflow-compatibility).
A passing suite is evidence for its asserted policy; also judge whether that policy
matches the requested behavior. Check blockers name the relevant artifact or issue
and give an actionable recovery step. Preserve actual user decisions and provenance.
