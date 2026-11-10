import { readFileSync, existsSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, requireThat } from './common.mjs';
import { appendMessage, conversationMessages } from './conversation-store.mjs';
import { readPromptQueue } from './issue-prompt-queue.mjs';

export function installedGrilling(root) {
  const paths = [join(root, '.agents/skills/grilling/SKILL.md'), join(homedir(), '.codex/skills/grilling/SKILL.md')];
  const path = paths.find(existsSync);
  requireThat(path, 'Install the grilling skill before starting this interview.');
  const canonical = realpathSync(path);
  return { name: 'grilling', path: canonical, sha256: digest(readFileSync(canonical)) };
}
export function grillingStage(queue, issue, state = issue.state) {
  const extra = [
    {
      state: '@integration',
      role: 'integration',
      name: 'Integrate',
      exit: 'Review the integration scope and required approvals; discussion does not merge changes.',
    },
    {
      state: '@other',
      role: 'other',
      name: 'Other work',
      exit: 'Discuss the additional recorded assignments without changing their outcomes.',
    },
  ];
  const stage = [...queue.lifecycle, ...extra].find((stage) => stage.state === state);
  requireThat(stage, 'Select a configured issue step.');
  return { state: stage.state, role: stage.role, name: stage.name, exit: stage.exit };
}
export async function beginGrilling(manager, session, stage, input, owner) {
  session.grilling = stage;
  session.skill = manager.skill(manager.service.root);
  session.interviewId = recordGrillingStart(manager.service.root, session.issueId, stage, session.skill).id;
  const text = `Begin a structured grilling interview for ${stage.name} only. Use the attached grilling skill, asking the whole currently answerable frontier in numbered rounds with recommendations. Target step: ${JSON.stringify(stage)}. Use supplied issue context for facts; state missing technical evidence rather than asking the person to find facts or claiming tools ran. Do not mark any stage complete or infer plan approval, test success or acceptance. The conversation is retained. Only the separate review-and-save control records decisions on the issue.`;
  const result = await manager.turn({ ...input, text }, owner, true);
  return { ...result, stage };
}

const list = { type: 'array', items: { type: 'string' } };
const summarySchema = {
  type: 'object',
  properties: { decisions: list, questions: list, answerQuotes: list },
  required: ['decisions', 'questions', 'answerQuotes'],
  additionalProperties: false,
};
export async function previewGrilling(manager, input, owner) {
  const { session, context } = manager.get(input, owner);
  const answers = grillingAnswers(manager.service.root, session);
  requireThat(session.grilling && answers.length, 'Answer the interview before reviewing its results.');
  requireThat(!session.busy, 'Wait for this response to finish.');
  requireThat(session.turns < 40, 'This chat reached its turn limit.');
  session.busy = true;
  session.turns++;
  session.intents.clear();
  try {
    await manager.ensureRuntime(session, context);
    const prompt = `Prepare a concise result for the ${session.grilling.name} interview. Return decisions, unresolved questions, and only relevant exact quotes from actual user answers. Quotes must be exact substrings of these user messages: ${JSON.stringify(answers.map((entry) => entry.body))}. Do not treat instructions, questions or recommendations as human answers. Do not claim tests, stage completion, implementation approval or acceptance. This draft will be reviewed before saving.`;
    const result = JSON.parse(await session.runtime.ask(prompt, [], summarySchema, { generated: true }));
    const { issue } = manager.get(input, owner);
    requireThat(
      digest(JSON.stringify(answers)) === grillingAnswerBasis(manager.service.root, session),
      'The interview changed. Review its results again.'
    );
    validateSummary(
      result,
      answers.map((entry) => entry.body)
    );
    return summaryIntent(manager, session, issue, result);
  } finally {
    session.busy = false;
  }
}
function validateSummary(result, answers) {
  for (const key of ['decisions', 'questions', 'answerQuotes']) {
    requireThat(
      Array.isArray(result[key]) && result[key].every((text) => typeof text === 'string' && text.trim()),
      'The interview summary is incomplete. Try reviewing its results again.'
    );
  }
  requireThat(result.answerQuotes.length > 0, 'The summary needs relevant actual answers.');
  for (const quote of result.answerQuotes)
    requireThat(
      answers.some((answer) => answer.includes(quote)),
      'A quoted answer was not supplied by you. Review again.'
    );
}
function summaryIntent(manager, session, issue, result) {
  const stage = session.grilling;
  const text = [
    `Grilling · ${stage.name}`,
    section('Decisions', result.decisions),
    section('Open questions', result.questions),
    section('Your selected answers', result.answerQuotes),
  ].join('\n\n');
  requireThat(text.length <= 8000, 'The summary is too long to save. Ask for a shorter interview summary.');
  const token = randomUUID();
  const hasIssueStrategy = Boolean(manager.service.lifecycleRuns[issue.id]?.work);
  const canContinue = !hasIssueStrategy && continuationAvailable(stage, issue, result);
  const intent = {
    kind: 'stage-record',
    interviewBasis: grillingAnswerBasis(manager.service.root, session),
    text,
    hash: digest(text),
    expires: manager.now() + 120000,
    stage,
    result,
    canContinue,
    skill: session.skill,
  };
  session.intents.set(token, intent);
  return {
    token,
    kind: intent.kind,
    text,
    stage,
    issueId: issue.id,
    canContinue,
    effect: `Save only this reviewed summary and selected answers to ${stage.name}. Saving does not approve a plan, pass tests or accept the issue. Save and continue separately asks the normal workflow to check what can proceed.`,
  };
}
function section(title, values) {
  return title + '\n' + (values.map((text) => '- ' + text).join('\n') || 'None recorded.');
}

function continuationAvailable(stage, issue, result) {
  if (result.questions.length) return false;
  return stage.state === issue.state && !['closed', 'ready-to-close'].includes(stage.role);
}

export function temporaryGrillingSkill(home, skill) {
  requireThat(skill.name === 'grilling', 'Choose the installed grilling skill.');
  const content = readFileSync(skill.path);
  requireThat(digest(content) === skill.sha256, 'The grilling skill changed. Start a fresh interview.');
  const folder = join(home, 'skills/grilling');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'SKILL.md');
  writeFileSync(path, content, { mode: 0o600 });
  return { name: skill.name, path: realpathSync(path) };
}

export function restoreGrilling(root, session) {
  const marker = conversationMessages(root, session.issueId).findLast((message) =>
    ['grilling-start', 'grilling-reviewed'].includes(message.kind)
  );
  if (marker?.kind !== 'grilling-start') return;
  session.interviewId = marker.id;
  session.grilling = marker.source.stage;
  session.skill = marker.source.skill;
}

function grillingAnswers(root, session) {
  const messages = conversationMessages(root, session.issueId);
  const start = messages.findIndex((message) => message.id === session.interviewId);
  if (start < 0) return [];
  const after = messages.slice(start + 1);
  requireThat(
    !after.some((message) => ['grilling-start', 'grilling-reviewed'].includes(message.kind)),
    'This interview changed. Reopen the decision review.'
  );
  const entries = new Map(readPromptQueue(root, session.issueId).entries.map((entry) => [entry.id, entry]));
  return after.map((message) => currentHumanAnswer(message, entries)).filter(Boolean);
}

export function grillingAnswerBasis(root, session) {
  return digest(JSON.stringify(grillingAnswers(root, session)));
}

export function finishGrilling(root, session) {
  appendMessage(root, session.issueId, {
    id: 'grilling-reviewed:' + session.interviewId,
    actor: 'factory',
    role: 'Factory',
    kind: 'grilling-reviewed',
    body: `Recorded reviewed grilling results for ${session.grilling.name}.`,
    source: { interviewId: session.interviewId, stage: session.grilling },
  });
}

export function recordGrillingStart(root, issueId, stage, skill, id = 'grilling-start:' + randomUUID()) {
  return appendMessage(root, issueId, {
    id,
    actor: 'factory',
    role: 'Factory',
    kind: 'grilling-start',
    body: `Started a grilling interview for ${stage.name}. Review and save decisions separately.`,
    source: { stage, skill },
  });
}

function currentHumanAnswer(message, entries) {
  if (!isHumanAnswer(message)) return null;
  if (message.kind === 'prompt-edit') return currentEditedAnswer(message, entries);
  const entry = entries.get(message.id);
  return entry ? currentQueuedAnswer(entry, 1) : { id: message.id, body: message.body };
}

function currentEditedAnswer(message, entries) {
  const separator = message.id.lastIndexOf(':');
  const entry = entries.get(message.id.slice(5, separator));
  return entry ? currentQueuedAnswer(entry, Number(message.id.slice(separator + 1))) : null;
}

function currentQueuedAnswer(entry, revision) {
  if (entry.generated || entry.status === 'removed' || entry.revision !== revision) return null;
  return { id: entry.id, revision: entry.revision, body: entry.text };
}

function isHumanAnswer(message) {
  return message.actor === 'human' && !message.generated;
}
