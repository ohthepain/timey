# Human input and grilling are separate from lifecycle

Decision accepted on 2026-10-23; implementation pending. Track pending human input
and completed grilling independently of lifecycle position and Matt Pocock triage
classification: an issue can need different human contributions at different
stages, while its grilling record remains useful after it advances. Keep the
existing needs-grilling stage for clarification, expose human work through the
existing issue listing, and block only affected work and dependencies; another
triage role would conflate these independent meanings.

The reusable contract and view belong in local-issues-skills; Timey supplies its
factory enforcement and project policy. This keeps shared semantics consistent
without imposing Timey's lifecycle and acceptance rules on every project.
