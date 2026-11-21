# Project Workspace: Home, Issues, Discuss, and Admin

The user confirmed shared understanding of the complete design and authorized
implementation on 2026-11-18 after the grill-with-docs session.

The Issues tab design was confirmed on 2026-11-19. That design confirmation
authorizes this documentation update; it does not authorize implementation.

## Confirmed decisions

- The project workspace design has Home, Issues, Discuss, and Admin tabs in that
  order. The Add menu remains a separate action. Home retains the current
  activity statistics, improvement operations, and saved-session navigation.
  The Issues tab and its relationship to folder views are defined in the
  [Project Issues tab design](project-issues.md).
- Discuss provides project conversations about the project as a whole, distinct
  from the queue-focused Coordinator conversation and individual issue conversations.
- Discuss can inspect and edit project files and carry out explicitly requested
  project operations within existing approval and issue-ownership rules.
- Project file work happens directly in the current working folder, like Codex.
  Do not create a separate checkout or branch for each project conversation.
- Discuss controls issues through their existing operations. It does not change
  issue handling, participate in issue execution, or receive ongoing issue input.
  The earlier proposal to report issue progress back into Discuss was rejected.
- Support multiple saved project conversations with New chat and a conversation
  selector. Retain each conversation's history, drafts, model, effort, and selected
  skills.
- Model, effort, and skill changes apply to subsequent messages. Running and
  already-queued messages retain the settings submitted with them.
- Voice input is dictation into editable composer text. The person chooses when
  to send it, including by saying “go” as the final word of a dictated prompt.
  This spoken send command authorizes submission without a separate manual Send
  action. Remove the final command word “go” before submitting the prompt.
  If the remaining prompt is empty or whitespace only, send nothing.
  Live spoken conversation is outside the initial scope.
- Retain the transcribed text and discard the dictation recording after
  transcription. On dictation failure, preserve the existing draft and offer
  retry or typing.
- The initial feature checklist includes Markdown and code rendering, copyable
  responses, file and image attachments, visible tool activity, live responses,
  Stop, queued messages, steering, model and effort controls, and skill selection.
- Keep copies of attachments as sent, so later changes to the original files do
  not alter conversation history. Attachments can be previewed and removed before
  sending.
- Offer suggested prompts. Tab accepts a suggestion into real editable composer
  text. Acceptance is separate from sending the message.
- Suggestions appear as faint text in an empty composer. Typing dismisses the
  suggestion. Tab accepts without sending; Enter sends accepted or typed text.
  When the skill picker is open, its keyboard controls take precedence.
- Each completed response offers one suggested next prompt based on that
  conversation. Generate it alongside the response, without separate background
  work. The person can accept it with Tab, type something else, or ignore it.
- Switching tabs, changing conversations, or refreshing leaves existing responses
  running. Restore history and the draft on return. Only explicit Stop interrupts
  a chat response; issue operations remain independent.
- Skills are searchable during composition and included with a submitted message.
  Selecting a skill alone starts no operation.
- Home operations become real reusable project skills, available in other chats
  for that project. Cover complete workflows, including configuring and running
  investigations and reviewing and applying Automate me drafts.
- Skill-invoked operations reuse the guarded operations behind the existing
  buttons, preserving their approval requirements and saved outcomes. In particular,
  investigation creation remains separate from running it, and Automate me retains
  explicit review and Apply.

## Chat and issue separation

Issue execution stays owned by the existing issue workflow. Discuss is a user
control surface for existing operations. No issue transcripts, background progress,
or completion events are automatically fed into the project conversation, and
there is no chat-side issue orchestration or mirrored issue state.

An issue command returns its direct factual result, such as started, archived,
or an error, with relevant links. Subsequent issue activity stays in the issue
interface. Discuss can query issue information when explicitly requested or needed
to fulfill a command, such as identifying closed issues before archiving them.
These ordinary query results do not import issue conversations or establish
ongoing updates.

Chat message editing and retries are independent of issue execution.
A failed response pauses queued work and preserves its error. Sending a new
message explicitly continues the chat with that message's current settings,
ahead of the older queue. Reading or refreshing never resumes failed work.
Explicit Stop and uncertain interrupted turns retain their existing Resume/Retry
requirements.

## Message editing and retries

- Queued messages can be edited or removed before execution. An explicit save can
  change their text, attachments, model, effort, and skills. Editing a queued
  message leaves the current response running.
- Edit on a sent message copies it to the composer. Sending the revision creates
  a new follow-up message and preserves the original history. Editing does not
  undo file changes or completed commands, and creates no history branches.
- Retry requests another response in the same conversation using the original
  message's model, effort, and skills. Retain interrupted responses and recorded
  tool results, with previous attempts inspectable. Issue operations retain their
  existing behavior.
- Each conversation has one active response. Retry waits until that response
  finishes or the user explicitly stops it. Queue editing, Steer, and copying
  earlier messages into the composer remain available during execution.

## Existing foundations

The issue chat supplies retained history, live output, Stop, queued message
editing/removal, steering, and native skill inputs. Its composer can discover
installed skills; live refresh needs extension. Model and effort are supported by
the transport but need controls independent of issue execution settings.

Voice capture, transcription, attachment submission, and richer message rendering
need new support. Existing Coordinator conversations have a narrower queue-selection
purpose and do not grant project-wide execution authority. Existing Automate me
sessions are deliberately limited to drafting reviewed skill changes.

## Clarification and automatic selection

- A top-level **Clarification skill** dropdown chooses the grilling skill used
  whenever a request remains ambiguous after checking available facts. This is
  an ordinary skill invocation, with no special looping mechanism or autonomous
  extra turns. The skill asks questions and waits for the person's answers.
- **No Grilling** is the default for new conversations and invokes no clarification
  skill. Existing conversations retain their saved choice.
- Available choices include **Grill Me** (`grill-me`), **Grill with Docs**
  (`grill-with-docs`), and **Grilling** (`grilling`). Retain the selected choice
  for the conversation until changed. Clear requests proceed directly.
- Automatically choose applicable registered tools and skills according to their
  registered selection and invocation rules. The explicitly selected clarification
  skill takes precedence for ambiguity. Actual calls appear in tool activity,
  and existing operation approval requirements remain in force.
- Preserve the distinction between a user-selected skill and implicit model
  selection. Explicit-only skills can be selected in the dropdown; they are not
  eligible for unrestricted implicit selection. Current discovery needs to retain
  authoritative invocation policy rather than discarding it.
- A skill supplies instructions; a callable project action supplies an executable
  operation. Register guarded project operations separately and expose reusable
  skills that use them. Do not treat skill instructions alone as callable tools
  or as enforcement of operation rules.

## Implementation shape

On 2026-11-21, the user requested the same chat UI and spoken send behavior
throughout the app while reviewing report discussion. The planned
[shared chat UI](investigation-reports.md#shared-chat-ui-and-behavior) reuses the
message view, composer, and send behavior while preserving each conversation's
history and ownership. This is a design requirement, not a completed refactor.

ProjectDiscuss owns project conversation records, queued messages, attachment
copies, and explicit turn controls. It shares the low-level Codex transport,
model settings and skill composer with existing chats. It does not reuse the
issue scheduler or create a synthetic issue to hold project conversation state.

The authenticated local HTTP interface exposes snapshots, explicit actions and
retained attachment downloads. The provider binds native dynamic tools to the
existing guarded project and issue operations. Navigation reads saved state;
it starts no work and does not stop an active response.

Two architectural sketches were compared: an independent project owner and an
extracted generic conversation journal. The independent owner is the base because
it keeps issue behavior unchanged and avoids introducing a generic abstraction
with only one production caller. Both sketches agreed on low-level transport
reuse and a separate guarded tool registry; the second sketch's per-message
settings snapshots and explicit recovery checks are included. The default arena
models and cross-family judge are unavailable in this environment, so two parent
model design seats were compared by the implementing agent.

## User acceptance scenario

The user withdrew the earlier instruction to archive closed issues directly.
Leave those issues unarchived for a live test of Discuss: request archiving all
closed issues through the new chat, inspect its action and outcome, and verify
the resulting Closed and Archive views. This records a future user-directed test,
not permission to archive them during development or automated verification.

## Implementation verification

The implementation passes 16 focused project-conversation/provider/tool checks,
76 existing chat/server-control/Home checks, and the focused Discuss and existing
Home browser scenarios. The native Codex smoke check called the real registered
project tool in a disposable folder and returned its fixture-only project name.
The saved-base step audit passed; Fallow was skipped under the local default.

Browser checks inject dictation responses, rather than using a real microphone.
Actual dictation uses browser speech recognition and requires browser support and
microphone permission. Unsupported browsers retain normal text input and explain
why dictation is unavailable. Real closed issues have not been archived; the
user's live Discuss archive test remains a separate acceptance step.

## Skill setup

The shared `createSkillSelect` control in `scripts/factory-ui/skill-select.js`
checks every listed skill against discovery and inserts **Set up skills** into
the dropdown when any are absent. Missing skill choices are disabled. Entries
with `kind: skill` declare their skill name; entries with `kind: value` are
ordinary choices with no skill dependency. **No Grilling** uses `kind: value`
and appears last, after any setup action.

Each project declares its own required skill sets in `user/skills/requirements.json`.
Each entry contains `name`, optional `source` (the installation URL), and `skills`
(the required skill names). This project registers pstack and Matt Pocock's
collection. Other projects can use different sources or declare project-owned
skills without a source URL. No configuration means no required collections. Setup
readiness is scoped to the skill options in this control, rather than unrelated
skills elsewhere in those collections.

Selecting Set up skills restores the saved selection and sends a visible
installation request in the selected chat (or creates a chat if needed), using
No Grilling and no selected skills. It preserves the composer draft and uses
normal queue and permission controls. Opening Discuss starts no installation.
Use Refresh skills afterward to update the control.

Factory supplies its own `skill-installer` in
`factory/system/skills/skill-installer/SKILL.md`. It installs complete skill
folders into the active project's `user/skills`, using the current project’s configured installation sources. Factory-owned skills take precedence over host
Codex skills with the same name, so setup does not depend on a personal Codex
installation or install into its private directory.

Selected Factory and Project skill instructions are included as text in the
actual turn, with their source path for resolving supporting resources. Native
Codex skill discovery does not know about the factory's custom directories;
passing only a native skill reference can silently omit these instructions.
Host-owned skills retain native skill inputs.

Required skill names are minimum readiness checks, not a filter on installing a
requested collection. Copy the full requested collection, including named skill
dependencies. Discuss translates vendor Skill-tool calls into reading the named
project skill file; it exposes those dependency paths separately from the
implicitly invocable catalogue.

The live Discuss installation test installed all 39 Matt Pocock skill folders
from revision `abeeaf95660ba9e8b7c753eb38f441ca707a8823`. An independent
comparison found no missing or changed upstream files. The first attempt copied
only two wrapper skills; the retained chat records that failure and the explicit
request that completed the collection.

Chat grilling options now come from `factory/system/chat/grilling.md`, with
additive project `user/chat/grilling.md` and personal Markdown extensions. The
shared selector keeps No Grilling last and offers Add skill to open the project
extension. Block selectors use their existing Markdown Skill lists and user
extensions; the separate block-skills JSON configuration has been removed.
