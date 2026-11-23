import { conversationMessages, conversationState } from './conversation-store.mjs';
import { attachIssueChat, createIssueChatConnection } from './issue-chat-runtime.mjs';
import { requireThat } from './common.mjs';
import { maximumTextInputLength, oversizedTextInputMessage } from './codex-input.mjs';

function hasAttemptOutput(attempt, block) {
  const output = attempt.output?.trim();
  return Boolean(output && output !== `Running ${block.kind} block.`);
}

function isAttemptRequest(message, attempt, block) {
  return (
    message.id === 'flow-request-' + attempt.id && message.kind === 'flow-block-request' && message.blockId === block.id
  );
}

function mayBeRejectedOversizedAttempt(block, attempt, binding) {
  return [
    ['uncertain', 'blocked'].includes(attempt.status),
    attempt.summary === oversizedTextInputMessage,
    !hasAttemptOutput(attempt, block),
    !binding?.flowReceipt,
  ].every(Boolean);
}

function exceedsInputLimit(request) {
  return request?.body?.length > maximumTextInputLength;
}

export function rejectedOversizedAttempt(service, flow, block, attempt, binding) {
  if (!mayBeRejectedOversizedAttempt(block, attempt, binding)) return false;
  const request = conversationMessages(service.root, flow.issueId).find((message) =>
    isAttemptRequest(message, attempt, block)
  );
  return exceedsInputLimit(request);
}

export async function observeDisconnectedFlow(service, flow, create = createIssueChatConnection) {
  const blocks = flow.blocks.filter((block) =>
    block.attempts.some(
      (attempt) => !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status)
    )
  );
  const state = conversationState(service.root, flow.issueId);
  const threads = blocks.flatMap((block) => {
    const binding = state.flowBlocks?.[block.id];
    const attempts = block.attempts.filter(
      (attempt) => !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status)
    );
    if (attempts.every((attempt) => rejectedOversizedAttempt(service, flow, block, attempt, binding))) return [];
    const threadId = binding?.threadId;
    requireThat(threadId, 'Recover the disconnected block’s original conversation before updating the branch.');
    return [threadId];
  });
  if (!threads.length) return blocks;
  const connections = new Set();
  try {
    for (const threadId of new Set(threads)) {
      const connection = create({ root: service.root, threadId, onEvent() {} });
      connections.add(connection);
      await connection.ready();
      await attachIssueChat(connection, flow.workspace.checkout, { threadId }, () => {}, 'read-only');
    }
  } finally {
    for (const connection of connections) connection.close();
  }
  return blocks;
}
