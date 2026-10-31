import { readFileSync, existsSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, requireThat } from './common.mjs';

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
  requireThat(!session.grilling, 'This chat already has an interview. End it before choosing another step.');
  session.grilling = stage;
  session.skill = manager.skill(manager.service.root);
  const text = `Begin a structured grilling interview for ${stage.name} only. Use the attached grilling skill, asking the whole currently answerable frontier in numbered rounds with recommendations. Target step: ${JSON.stringify(stage)}. Use supplied issue context for facts; state missing technical evidence rather than asking the person to find facts or claiming tools ran. Do not mark any stage complete or infer plan approval, test success or acceptance. The interview is temporary until the person reviews and saves selected results.`;
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
  const { session } = manager.get(input, owner);
  requireThat(session.grilling && session.answers.length, 'Answer the interview before reviewing its results.');
  requireThat(!session.busy, 'Wait for this response to finish.');
  requireThat(session.turns < 40, 'This chat reached its turn limit.');
  session.busy = true;
  session.turns++;
  session.intents.clear();
  try {
    const prompt = `Prepare a concise result for the ${session.grilling.name} interview. Return decisions, unresolved questions, and only relevant exact quotes from actual user answers. Quotes must be exact substrings of these user messages: ${JSON.stringify(session.answers)}. Do not treat instructions, questions or recommendations as human answers. Do not claim tests, stage completion, implementation approval or acceptance. This draft will be reviewed before saving.`;
    const result = JSON.parse(await session.runtime.ask(prompt, null, summarySchema));
    const { issue } = manager.get(input, owner);
    validateSummary(result, session.answers);
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
  const canContinue = continuationAvailable(stage, issue, result);
  const intent = {
    kind: 'stage-record',
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
