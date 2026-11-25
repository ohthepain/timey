import { redactValue } from './activity.mjs';

const publicItems = new Set([
  'userMessage',
  'agentMessage',
  'plan',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageView',
  'imageGeneration',
  'collabAgentToolCall',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
]);

export function exportRetroThread(id, thread, attempts = [], unavailableReason = null) {
  const linked = attempts.filter(
    (attempt) => attempt.result?.threadId === id || repairTurns(attempt).some((repair) => repair.threadId === id)
  );
  const base = { id, attemptIds: linked.map((attempt) => attempt.id) };
  if (!Array.isArray(thread?.turns)) return unavailableThread(base, unavailableReason);
  return redactValue({
    ...base,
    createdAt: thread.createdAt ?? null,
    turns: thread.turns.map((turn, sequence) => exportTurn(turn, sequence, linked, id)),
    coverage:
      'Turns and items retain provider order. Missing timestamps are null. Thread attempt IDs identify linked attempts, not ownership of every turn. Permission decisions absent from provider records are unavailable. Private reasoning is excluded. Unknown item payloads are unavailable.',
  });
}

function unavailableThread(base, reason) {
  return redactValue({
    ...base,
    unavailable: true,
    unavailableReason: reason || 'The provider did not return turns.',
  });
}

export function repairTurns(attempt) {
  return (attempt.evidence ?? []).flatMap(({ repairTurn }) => (repairTurn ? [repairTurn] : []));
}

function exportTurn(turn, sequence, linked, threadId) {
  const repairsForTurn = (attempt) =>
    repairTurns(attempt).filter((repair) => repair.threadId === threadId && repair.turnId === turn.id);
  const attemptIds = linked
    .filter((attempt) => matchesTurn(attempt, turn.id) || repairsForTurn(attempt).length)
    .map((attempt) => attempt.id);
  const repairAttemptIds = linked.flatMap((attempt) => repairsForTurn(attempt).map(({ id }) => id));
  const items = (turn.items || []).map(exportItem);
  return {
    ...Object.fromEntries(['id', 'startedAt', 'completedAt'].map((key) => [key, turn[key] ?? null])),
    sequence,
    status: turn.status,
    attemptIds,
    repairAttemptIds,
    attemptAssociation: attemptIds.length ? 'recorded-turn-id' : 'unavailable',
    items,
    permissionDecisions: permissionAvailability(items),
  };
}

function matchesTurn(attempt, turnId) {
  const savedId = attempt.result?.turnId || attempt.resultTurnId;
  return Boolean(turnId) && savedId === turnId;
}

function permissionAvailability(items) {
  return items.some((item) => terminalReview(item)) ? 'recorded' : 'unavailable';
}

function terminalReview(item) {
  return (
    item.type === 'autoApprovalReview' && ['approved', 'denied', 'timedOut', 'aborted'].includes(item.review?.status)
  );
}

function itemTiming(item, sequence) {
  return { sequence, timestamp: item.startedAt ?? item.createdAt ?? item.timestamp ?? null };
}

const itemProjectors = new Map([
  ['message', publicMessage],
  ['autoApprovalReview', publicApproval],
]);

function exportItem(item, sequence) {
  const timing = itemTiming(item, sequence);
  if (publicItems.has(item.type)) return { ...item, ...timing, ...toolOutcome(item) };
  const project = itemProjectors.get(item.type) || unavailableItem;
  return { ...project(item), ...timing };
}

function publicMessage(item) {
  if (!['user', 'assistant'].includes(item.role)) return unavailableItem(item);
  return {
    id: item.id,
    type: item.type,
    role: item.role,
    content: (item.content || []).filter((part) => ['input_text', 'output_text', 'text'].includes(part.type)),
  };
}

function publicApproval(item) {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    review: { status: item.review?.status, rationale: item.review?.rationale },
  };
}

function unavailableItem(item) {
  return {
    id: item.id,
    type: item.type,
    unavailable: 'This item payload is not a supported public record.',
  };
}

function toolOutcome(item) {
  if (
    !['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'function_call_output', 'custom_tool_call_output'].includes(
      item.type
    )
  )
    return {};
  const recorded = ['aggregatedOutput', 'output', 'result', 'content', 'error', 'exitCode'].some(
    (key) => item[key] !== undefined && item[key] !== null
  );
  return { outcomeAvailability: recorded ? 'recorded' : 'unavailable' };
}
