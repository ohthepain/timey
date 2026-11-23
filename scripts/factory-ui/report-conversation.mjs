import { appendMessage } from './conversation-store.mjs';

export function retainReportConversation(root, session) {
  if (session.ownership?.kind !== 'investigation') return;
  const messages = session.messages.filter(
    (message) => message.reportContext && !message.imported && message.status !== 'historical'
  );
  for (const message of messages) {
    appendMessage(root, session.ownership.issueId, reportMessage(message));
  }
}

function reportMessage(message) {
  return {
    id: message.id,
    actor: message.role === 'user' ? 'human' : 'agent',
    role: message.role === 'user' ? 'You' : 'Issue assistant',
    kind: 'report-discussion',
    body: message.text,
    status: message.status,
    replyTo: message.replyTo,
    at: message.createdAt,
    reportContext: message.reportContext,
    source: { reportId: message.reportContext.reportId, attemptId: message.reportContext.source.attemptId },
  };
}
