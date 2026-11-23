# Anthropic and Google model support

The user confirmed shared understanding and authorized implementation on
2026-11-23. The agreed scope below is the implementation boundary.

## Agreed scope

On 2026-11-23, the user confirmed both first-round recommendations:

- Add Anthropic and Google support in the first release. Defer Cursor, Grok,
  Composer, and open weight models.
- Support coding work, including file edits, commands, and implementation flow
  blocks, alongside discussion and planning.

The user also confirmed the second-round recommendations:

- Cover issue chats, project discussions, and ordinary model-driven flow blocks.
  Background helpers and the explicitly named Sol reviewer retain their current
  behavior in the first release.
- Extend the existing model selectors, project and folder defaults, and issue
  overrides. Show only settings supported by the selected agent.
- Keep each conversation with the agent that created it. Changing providers
  starts a fresh conversation with an explicit handoff summary and preserves the
  original history.

The user confirmed the connection and failure policy:

- Run the installed Claude Code and Gemini CLI agents, using their supported
  authentication and billing. Existing subscriptions are a first-class requirement.
  API credentials may be supplied through each agent's supported configuration.
- Missing installation, authentication failures, rate limits, and agent failures
  stop the affected operation with an actionable explanation. Preserve completed
  work and failure details. Retry or provider changes require an explicit choice.
  Never silently switch providers, models, or billing methods.

The user confirmed the operational requirements and model scope:

- Show tool activity and approval requests in Timey, support Stop, and retain
  session information for restart recovery. Require explicit recovery when an
  operation's outcome is uncertain; never automatically replay uncertain work.
- Supply applicable project instructions, selected skill content, and the Timey
  tools required for assigned work. Explain unsupported required capabilities
  before starting the task.
- Offer a small supported model list for each agent, verified during
  implementation, with only supported configuration options. Defer custom
  endpoints and arbitrary model IDs.

## Implementation evidence required

The exact transport, supported agent versions, model identifiers, and capability
mapping require focused integration checks. These are technical investigations
within the agreed scope. A conflict with subscription support, approvals,
instructions, tools, or recovery must return for a design decision rather than
silently reducing the requirements.

Verify each integration through the actual Timey workflow:

- Start and continue an issue chat and a project discussion with the selected agent.
- Execute an ordinary model-driven flow block that edits a file and runs a command.
- Check model default inheritance, issue overrides, and supported option display.
- Demonstrate tool activity, approval allow and deny, Stop, and restart recovery.
- Confirm applicable instructions, selected skills, and required Timey tools reach
  the agent, with unsupported required capabilities reported before dispatch.
- Exercise missing installation, missing authentication, a provider failure, and
  unavailable model handling without silent substitution.
- Change providers explicitly and inspect the fresh conversation, handoff summary,
  and retained original history.
- Verify existing Codex operation and the deferred helpers and Sol behavior.

Retain actual results and limitations. Missing credentials or inaccessible models
leave the corresponding live check unverified.

## Existing constraints

The current runtime uses Codex app-server for native threads, turns, tools,
approvals, and recovery. Model choices alone cannot supply another coding agent.
See `scripts/factory-ui/codex.mjs` and
`scripts/factory-ui/discussion-codex.mjs`.

[ADR 0007](../adr/0007-codex-owns-issue-conversations.md) assigns issue
conversations to Codex. [ADR 0013](../adr/0013-explicit-issue-flows.md)
gives model blocks separate Codex conversations. A design that assigns these
conversations to another agent must explicitly revise the affected decisions.

## Integration evidence

- [Claude Code authentication and product integration](https://code.claude.com/docs/en/legal-and-compliance)
  documents running the unmodified binary with end-user authentication and billing.
- [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/)
  documents Google sign-in and API credentials.
- [Gemini CLI ACP](https://geminicli.com/docs/cli/acp-mode/) provides a native
  integration protocol. The exact transport and approval behavior still need a
  working integration check before implementation can claim support.

## Setup and current limits

Install Claude Code and Gemini CLI through their official distribution, and sign
in through each tool on the machine running Timey. Timey uses the configured
vendor login and billing; it does not collect subscription tokens or change global
agent configuration. Choose Claude Sonnet, Claude Opus, Gemini Pro, or Gemini Flash
in the existing model controls. A listed alias does not guarantee account access
or remaining quota; the native agent reports those failures without substitution.

The initial protocol probe passed with Claude Code 2.1.330 and Gemini CLI 0.70.0.
The integration checks advertised model aliases, Gemini session loading, and
required HTTP MCP support during startup. Native agents use their own permission
systems; these checks do not establish Codex-equivalent operating-system sandboxing.

Native images and structured output schemas are currently rejected before prompt
dispatch with an explanation. Text attachments and selected skill contents are
supplied inline. Background helpers and the named Sol reviewer stay on Codex.
Started issue settings keep their existing freeze; the provider handoff control
applies to project discussions when the selected provider changes.

After an interrupted native session, inspect file changes, command results, and
retained output. Stop the original agent work before confirming recovery. Issue
chat offers Recover agent session; Flow Continue and project discussion Retry
request explicit recovery confirmation. Recovery refuses a live original process
group and never sends a prompt itself.

## Implementation and verification status

The local implementation supplies the native adapters, existing model controls,
chat and ordinary Flow integration, guarded Timey tools, instructions and skills,
approval and question cards, Stop, explicit recovery, and project discussion
handoffs. Codex-only helpers and Sol retain their execution paths. Changes remain
uncommitted in a checkout that already contained unrelated staged and unstaged work.

Protocol fixtures and browser checks pass. Both official vendor binaries passed
initialization probes without a model prompt. Authenticated coding, native
permission pauses, and live session continuation have not been demonstrated;
these remain required before calling either integration ready.

The strict whole-checkout audit remains blocked by complexity findings in
`ensureProjectStores` and `atomicIssueSave`, outside this feature. The native
adapters and the feature's routing and UI changes have no new complexity findings.
The existing checkout's other findings have been preserved.

The [local verification record](../../.issues/evidence/native-agent-support-eo1s7jqo/verification.json)
retains commands, results, limitations, and source hashes. This evidence is local
and is not published with the source.
