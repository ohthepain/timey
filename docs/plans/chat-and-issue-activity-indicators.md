# Chat and issue activity indicators

The user confirmed this design on 2026-11-23, including the anchored issue
overlay, and authorized implementation. Verification results appear below.

## Agreed behavior

Coding-agent conversations show one live progress line beneath the latest
message. The line changes as work proceeds and clears when the response ends.
SparkleText animates during active work. The line stays readable and still
when reduced motion is enabled.

The agent can supply a progress label and description. Recognizable commands
provide fallback labels such as Exploring and Verifying. The default for an
unrecognized command is Running commands. An explicit milestone records a
finding, change, result, or resolved blocker. The commands leading up to that
milestone appear in a collapsed disclosure. Commands are also available under
the live line, then under the final reply if the agent did not record a milestone.
Blocking failures and pending approvals or decisions are visible separately.

The issue page also shows the indicator at the bottom while work is actively
running. It stays anchored just above the bottom edge of the issue's scrolling
region and does not move when the person scrolls. Blocks scroll behind the
indicator. It is an overlay within that region, rather than a footer at the end
of the scrollable content. The overlay does not block interaction with the blocks.
Queued, paused, failed, and waiting-for-input states do not animate.
If a pause lets the current work finish, the indicator follows that actual work.

A trustworthy duration estimate can vary the animation within a calm speed
range. Short expected waits bounce faster, and long expected waits bounce more
slowly. An unknown duration uses a steady default. The dots communicate activity
and do not represent a percentage or countdown.

Use the steady default speed until a real estimate is available. Learning
estimates from past runs is outside this change.

The issue overlay respects reduced-motion preferences with static dots.
Screen readers receive status updates as the progress line changes.

## Existing behavior

Project and report discussions share `scripts/factory-ui/project-discuss-ui.js`.
Classic issue chat uses `scripts/factory-ui/issue-chat-ui.js`. Flow renders block
responses separately and has a running-status footer in
`scripts/factory-ui/flow-ui.js`.
The requested indicator uses the anchored overlay placement described above;
the existing footer's location does not determine its placement.
The Automate me interview has its own renderer in
`scripts/factory-ui/project-home-ui.js` and is included in the chat scope.
Classic decision review and coordinator conversations also use the shared dots.
Investigations and Request clarification use Flow attempts, whose activity can
continue after the HTTP request returns.

Discussion responses retain their running state throughout streaming and tool
work. Pending sends also need immediate feedback. Historical disconnected
responses must not appear active. Human-input waits can coexist with running
session state, so that state alone does not establish active work.

Inspection found elapsed timers but no response-duration estimate.

## Implementation

`scripts/factory-ui/chat-progress.mjs` projects provider events into a live
progress group, retained milestones, and command details. The Flow attempt
and Discuss response retain those events for reload and reopening.
Project Discuss and investigation report discussions share the same renderer.

`scripts/factory-ui/activity-indicator-ui.js` provides the shared markup and
updates. `scripts/factory-ui/chat-progress.css` owns the progress line and
reduced-motion styles. Rendered histories retain the same progress line
during streaming and polling. The issue overlay uses the dots in
`scripts/factory-ui/project-discuss.css`.

The issue overlay sits outside `graph-scroll`, inside the positioned
`graph-region`. It stays centered 18 pixels above the scrolling region's bottom
edge and allows pointer events to reach the blocks underneath. Work activity
excludes pending agent permissions, questions, and other human-input requests.
Active branch updates and branch repairs also show the issue dots. A branch
repair awaiting candidate approval does not animate.

## Verification

The focused browser command passed with the final UI assets:

```sh
node scripts/flow-browser.mjs --activity-indicators --project-discuss --automate-activity
```

[Browser results](../../.issues/evidence/flow-browser-62fef428-05da-418e-859a-4fce5d073329/results.json)
retain the candidate asset hashes. Screenshots cover streaming chat, Automate me,
the issue overlay during scrolling, reduced motion, and mobile placement. The
Flow execution and Automate me provider are held fixtures. Branch-repair display
states are injected into a view response, rather than running a live repair.

The focused DOM checks pass for streaming, stable indicator identity,
human-input waits, terminal and disconnected states, Classic chat, and the
coordinator. Existing chat, discussion, and refresh suites also passed after
rerunning four HTTP checks outside the sandbox's localhost restriction.

Broader browser runs encountered failures before their activity assertions.
The [Project Home run](../../.issues/evidence/flow-browser-7e8e8493-04d4-4a75-9beb-831b70310bc6/results.json)
timed out during archived-branch cleanup. The
[branch-repair run](../../.issues/evidence/flow-browser-9ba046c6-ba60-4632-b287-f41719c95068/results.json)
expected an automatic inspector request that did not occur. These runs do not
establish passing broad regression coverage.

The default step audit ran with Fallow skipped by repository policy. The opt-in
strict Fallow audit failed with complexity and CSS-reference warnings across
the working candidate, which includes earlier changes from other work. Its
CSS-reference warnings include the nested dot and accessibility-label classes
exercised by the focused browser run. No thresholds or exclusions were changed.
The implementation has focused behavior proof, but the strict step gate remains
blocked and no full verification, publication, merge, or acceptance is claimed.

## Documentation scope

The existing conversation and human-input terminology remains sufficient. This
change introduces no project-specific domain term or architectural commitment
that requires a glossary entry or ADR.

## Investigation toolbar layout correction

The activity overlay introduced a horizontal `graph-region` wrapper around the
scrolling graph. Investigation controls still inserted themselves before the
inner `graph-scroll`, placing them beside the graph. This was an unintended
layout regression. The controls now insert before the outer region and retain
their existing position above the flow. A focused saved-flow browser scenario
checks geometry and ordinary-flow hiding without creating or running an
investigation.
