import { readQueue } from './data.mjs';
import { digest, requireThat } from './common.mjs';
import { saveLifecycle } from './lifecycle-store.mjs';
import { stopLifecycle } from './lifecycle-stop.mjs';

export function applyLifecyclePlanning(service, issue, result) {
  const record = service.lifecycleRuns[issue.id];
  if (!record) return false;
  if (result.next_action === 'question') return askNextQuestion(service, record, result);
  return validateNextTask(service, record, result);
}
function validateNextTask(service, record, result) {
  if (result.next_action === 'blocked') {
    stopLifecycle(service, record, result.next_step || result.summary);
    return true;
  }
  if (result.next_action === 'work')
    requireThat(
      result.recommendations.length,
      'The review identified unfinished work but did not provide a task to start. No completed-work review was repeated.'
    );
  return false;
}
function askNextQuestion(service, record, result) {
  const question = result.human_question;
  requireThat(
    question?.question?.trim().endsWith('?'),
    'The review must ask a concrete question before requesting your input.'
  );
  requireThat(
    question.why?.trim() && question.expected?.trim(),
    'Explain why the answer is needed and what to supply.'
  );
  requireThat(
    !result.recommendations.length,
    'A question must be answered before recommending work that depends on it.'
  );
  const issue = readQueue(service.root).issues.find((i) => i.id === record.issueId);
  saveLifecycle(service, record, {
    status: 'waiting',
    summary: question.why,
    input: {
      type: 'questions',
      origin: 'next-action',
      questions: [{ id: 'next-decision', ...question }],
      reportHash: digest(issue.content),
    },
  });
  return true;
}
