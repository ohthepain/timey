import { LocalNotes } from './local-notes.mjs';

function recommendation(id, label, prompt) {
  return { id, label, prompt };
}

const createPrompt =
  'Create the issue from the wording and scope agreed in this conversation. Use the issue creation tool and report its result.';

function navigationPrompt(id, label, target) {
  if (!target) return [];
  return [
    {
      ...recommendation(id, label, `Open the discussion of local note ${target.id} using its current text.`),
      targetId: target.id,
    },
  ];
}

function creationPrompts(note, next) {
  if (note.issueId) return [];
  const create = recommendation('create', 'Create issue', createPrompt);
  if (!next) return [create];
  return [
    create,
    {
      ...recommendation(
        'create-delete-next',
        'Create, delete & next',
        `${createPrompt} After issue creation succeeds, Factory should delete source local note ${note.id} and open the discussion of note ${next.id}. If issue creation fails, keep the source note and stay here.`
      ),
      targetId: next.id,
    },
  ];
}

function noteRecommendations(root, session, skills) {
  const { notes } = new LocalNotes(root).view();
  const index = notes.findIndex(({ id }) => id === session.noteContext.id);
  if (index < 0) return [];
  const note = notes[index];
  const next = notes[index + 1];
  return [
    ...creationPrompts(note, next),
    recommendation('delete', 'Delete note', `Delete only the source local note ${note.id}.`),
    ...navigationPrompt('next', 'Next', next),
    ...navigationPrompt('prev', 'Prev', notes[index - 1]),
    ...grillingRecommendation(session, skills),
  ].map((entry) => ({ ...entry, noteId: note.id }));
}

function grillingRecommendation(session, skills) {
  const selected = skills.filter(({ skill }) => skill).find(({ name }) => name === session.settings.clarificationSkill);
  if (!selected || session.noteContext.grilled) return [];
  const label = { 'grill-with-docs': 'Grill with docs' }[selected.name] ?? 'Grill';
  return [
    recommendation(
      'grill',
      label,
      `Use the ${selected.name} skill to grill me on turning this note into an issue. Ask the next unresolved question and wait for my answer.`
    ),
  ];
}

const reportRecommendations = [
  recommendation('report-findings', 'Explain the findings', 'Explain the most important finding in this report.'),
  recommendation('report-priorities', 'Prioritize recommendations', 'Which recommendations should we act on first?'),
  recommendation(
    'report-followups',
    'Create follow-up issues',
    'Create approval-needed follow-up issues for uncovered work in this report, linking matching existing issues.'
  ),
];

function baseRecommendations(root, session, skills) {
  if (session.noteContext) return noteRecommendations(root, session, skills);
  if (session.ownership?.kind === 'investigation') return reportRecommendations;
  return [];
}

export function discussionRecommendations(root, session, skills) {
  const latest = session.messages.findLast(({ role, status }) => role === 'assistant' && status === 'completed');
  const contextual = latest?.recommendations || [];
  return [...baseRecommendations(root, session, skills), ...contextual];
}

function noteDirection(id) {
  return id === 'prev' ? -1 : 1;
}

function currentTarget(notes, index, { id, targetId }) {
  if (!targetId) return undefined;
  const target = notes[index + noteDirection(id)];
  if (target?.id !== targetId) throw Error('The local note order changed. Choose a current prompt.');
  return target;
}

export function currentNoteRecommendation(root, { recommendation: operation }) {
  const notes = new LocalNotes(root);
  const state = notes.view();
  const index = state.notes.findIndex(({ id }) => id === operation.noteId);
  if (index < 0) throw Error('This local note no longer exists.');
  return {
    operation,
    notes,
    basis: state.basis,
    source: state.notes[index],
    target: currentTarget(state.notes, index, operation),
  };
}

export async function executeNoteRecommendation(root, message, visit) {
  if (!['delete', 'next', 'prev'].includes(message.recommendation?.id)) return null;
  const { operation, notes, basis, source, target } = currentNoteRecommendation(root, message);
  if (operation.id === 'delete') {
    notes.action({ action: 'delete', id: source.id, basis });
    return { text: 'Deleted the source note.' };
  }
  await visit(target);
  return { text: 'Opened the discussion for the selected note.' };
}
