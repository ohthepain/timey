import { conversationMessages, conversationState } from './conversation-store.mjs';
import { attachIssueChat, createIssueChatConnection } from './issue-chat-runtime.mjs';
import { requireThat } from './common.mjs';
import { maximumTextInputLength, oversizedTextInputMessage } from './codex-input.mjs';

export function rejectedOversizedAttempt(service, flow, block, attempt, binding) {
  if (
    !['uncertain', 'blocked'].includes(attempt.status) ||
    attempt.summary !== oversizedTextInputMessage ||
    (attempt.output?.trim() && attempt.output.trim() !== `Running ${block.kind} block.`) ||
    binding?.flowReceipt
  )
    return false;
  const request = conversationMessages(service.root, flow.issueId).find(
    (message) =>
      message.id === 'flow-request-' + attempt.id &&
      message.kind === 'flow-block-request' &&
      message.blockId === block.id
  );
  return request?.body?.length > maximumTextInputLength;
}

export async function observeDisconnectedFlow(service, flow, create = createIssueChatConnection) {
  const blocks = flow.blocks.filter((block) =>
    block.attempts.some(
      (attempt) => !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status)
    )
  );
  if (!blocks.length) return blocks;
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
  const connection = create({ onEvent() {} });
  try {
    await connection.ready();
    for (const threadId of new Set(threads))
      await attachIssueChat(connection, flow.workspace.checkout, { threadId }, () => {}, 'read-only');
  } finally {
    connection.close();
  }
  return blocks;
}
