# Investigation flows and reports: draft wayfinder map

This is a staging document. The map and child decisions have not been created
in the issue queue. All five planning decisions are resolved in this document
and the linked design brief. The planning destination has been reached.
No queue ticket has been claimed, resolved, or closed. Publication requires
the project's registered issue tools, which were unavailable in the originating
chat. The project Discuss interface is the next place to publish the map through
its guarded issue operations.

The implementation handoff has since been captured through the existing UI as
[Implement investigation flows and reports](http://127.0.0.1:4317/?issue=20261121T104937769-06e3427f667db7d9).
It was created idle in Inbox and subsequently explicitly started by the user.
That Start authorizes implementation within the agreed design through the
issue's existing controls. The planning map and its child decisions remain
documents rather than published queue tickets.

## Destination

An agreed design for investigation flows with optional report and issue outputs,
a project Reports tab, and report discussion in the existing investigation chat.
The design is ready for a separate implementation effort. All named product
and ownership decisions have answers. The user supplied the separate implementation
authorization by explicitly starting the linked issue.

## Notes

The [design brief](investigation-reports.md) records the user's confirmed scope
and product choices. It includes implementation responsibilities and future
acceptance scenarios for the handoff.
Implementation, production skill authoring, and starting existing investigations
are outside this planning effort.

Use wayfinder, grilling, and domain-modeling. Use prototype for the reading and
discussion experience. Follow the repository's wayfinding tracker adapter.
Published map and decision reports need their prescribed kinds, labels, parent
links, and dependency sections. Keep planning reports outside ordinary execution.
Resolve at most one decision per session after charting.

## Decisions so far

- [Reading and discussing a report](investigation-reports.md#reading-and-discussing-a-report):
  The user revised the direction to full-width discussion below the report,
  with prompt pills and a thin resizable divider, and approved the revised
  prototype. Shared chat UI and spoken send behavior are required across the app.
  Message context and restored reading and draft state remain agreed.
- [Connecting investigation outputs to flow blocks](investigation-reports.md#connecting-investigation-outputs-to-flow-blocks):
  Output blocks may investigate newer code and pass additional findings forward.
  Output attempts stay under their original run; Run again creates a fresh run.
  Report failure pauses the route while issue creation remains manually available.
- [Defining the output skills and their guarded operations](investigation-reports.md#defining-the-output-skills-and-their-guarded-operations):
  Skills own saving and return source-linked output references. Only successful
  blocks forward findings; Retry preserves saved issues and creates the remainder.
  Reports share a rich reader, and existing matching issues are linked unchanged.
- [Retaining reports and their discussion context](investigation-reports.md#retaining-reports-and-their-discussion-context):
  Timey retains report and evidence copies. Retry recovers the same publication;
  deliberate generation creates a new report. Discussion continues after archival,
  and reports remain readable with unavailable evidence clearly flagged.

- [Adopting the flow for existing investigations](investigation-reports.md#adopting-the-flow-for-existing-investigations):
  Idle standard flows adopt automatically without starting work. Completed work
  stays completed. Custom layouts require explicit rebuild, and active runs finish
  before adopting the new layout.

## Unanswered decisions

None. The planning answers are complete. No queue tickets were created or closed;
publication through the registered issue controls remains a handoff.

## Not yet specified

None within the planning destination. Implementation responsibilities and future
acceptance scenarios are recorded in the design brief. Exact storage, schemas,
module interfaces, and sequencing remain engineering choices within the agreed
requirements rather than unresolved product questions.

## Out of scope

Production implementation and implementation approval belong to a later effort.
PDF and other exports are deferred. This effort does not start, approve, close,
or archive any existing investigation.
