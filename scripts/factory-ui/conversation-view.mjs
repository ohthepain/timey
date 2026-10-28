import { redactValue } from './activity.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conversationMessages, conversationState, conversationFiles } from './conversation-store.mjs';

function roleFor(queue, run) {
  const roles = { integration: 'Integrate', coordinator: 'Review', reconciliation: 'Review', 'plan-review': 'Review' };
  return roles[run.kind] || stageRole(queue, run);
}
function stageRole(queue, run) {
  const stage = queue.lifecycle.find((entry) => entry.state === run.issueState);
  if (stage) return stage.name;
  const action = queue.actions.find((entry) => entry.id === run.actionId);
  const kind = action ? action.kind : run.kind;
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
function selectedRun(queue, issue, run) {
  if (run.issueId === issue.id) return true;
  return queue.actions.some((action) => action.id === run.actionId && action.issues.includes(issue.id));
}
function runMessage(queue, run) {
  const result = run.result || {},
    questions = result.questions || [];
  return {
    id: 'run:' + run.id,
    actor: 'agent',
    role: roleFor(queue, run),
    kind: 'role-result',
    at: run.created,
    status: run.status,
    source: { runId: run.id, threadId: run.threadId },
    body: redactValue(
      [result.summary || run.summary, ...questions.map((question) => question.question), result.notes]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 12000)
    ),
  };
}
export function conversationTimeline(service, queue, issue) {
  const stored = conversationMessages(service.root, issue.id);
  const runs = service.store.runs.filter((run) => selectedRun(queue, issue, run)).map((run) => runMessage(queue, run));
  const stages = (issue.lifecycle_history || []).map((entry, index) => ({
    id: 'stage:' + index + ':' + entry.at,
    actor: entry.actor === 'human' ? 'human' : 'factory',
    role: queue.lifecycle.find((stage) => stage.state === entry.state)?.name || entry.state,
    kind: 'stage-outcome',
    at: entry.at,
    body: entry.outcome + ': ' + entry.reason,
    source: { revision: entry.revision },
  }));
  return [...stored, ...runs, ...stages, ...retainedAnswers(service, issue)].sort(
    (a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id)
  );
}
const answerCache = new Map();
function retainedAnswers(service, issue) {
  const directory = service.store.directory;
  if (!existsSync(directory)) return [];
  const answers = readdirSync(directory)
    .filter((name) => /^answer-.*\.json$/.test(name))
    .map((name) => {
      const path = join(directory, name);
      if (!answerCache.has(path)) answerCache.set(path, JSON.parse(readFileSync(path, 'utf8')));
      return { name, value: answerCache.get(path) };
    });
  return answers
    .filter(({ value }) => actualAnswer(value, issue.id))
    .map(({ name, value }) => ({
      id: 'answer:' + name,
      actor: 'human',
      role: 'You',
      kind: value.type,
      at: value.at,
      body: value.answer || value.type,
      source: { receipt: join(directory, name) },
    }));
}
function actualAnswer(value, id) {
  return (
    value.issueId === id &&
    value.actor === 'human' &&
    ['clarification', 'plan-approval', 'requested-plan-change', 'integration-approval'].includes(value.type)
  );
}
export function conversationPage(service, queue, issue, before = '') {
  const timeline = conversationTimeline(service, queue, issue);
  const end = pageEnd(timeline, before),
    messages = historyPage(timeline, end);
  const state = conversationState(service.root, issue.id);
  return {
    issueId: issue.id,
    messages,
    hasMore: messages.length < end,
    cursor: messages[0]?.id,
    status: state.status,
    responseId: service.issueChats?.active.get(issue.id)?.messageId || null,
    connected: chatConnected(service, issue.id),
    transcript: conversationFiles(service.root, issue.id).log,
  };
}

function pageEnd(timeline, before) {
  const end = before ? timeline.findIndex((entry) => entry.id === before) : timeline.length;
  if (end < 0) throw Error('This history cursor is no longer available. Refresh the conversation.');
  return end;
}
function historyPage(timeline, end) {
  let bytes = 0;
  const messages = [];
  for (const entry of timeline.slice(0, end).reverse()) {
    if (messages.length >= 60 || bytes > 96000) break;
    messages.unshift(entry);
    bytes += JSON.stringify(entry).length;
  }
  return messages;
}
function chatConnected(service, id) {
  return service.issueChats?.tasks.has(id) || false;
}
