import { requireThat } from './common.mjs';
import { conversationMessages } from './conversation-store.mjs';

function ownership(report) {
  return { kind: 'investigation', issueId: report.source.issueId };
}

function ordinaryMessages(discuss, report) {
  return conversationMessages(discuss.service.root, report.source.issueId).map((message) => ({
    id: message.id,
    role: message.actor === 'human' ? 'user' : 'assistant',
    text: message.body,
    status: message.status || 'historical',
    imported: true,
    attachments: [],
    events: [],
    createdAt: message.at,
    investigationContext: { issueId: report.source.issueId, blockId: message.blockId, source: message.source },
    reportContext: message.reportContext,
  }));
}

function mergeHistory(discuss, session, messages) {
  const known = new Set(session.messages.map(({ id }) => id));
  const additional = messages.filter(({ id }) => !known.has(id));
  if (!additional.length) return;
  discuss.change(session.id, (saved) => {
    saved.messages.push(...additional);
    saved.messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  });
}

export function reportDiscussionView(discuss, report) {
  const owner = ownership(report);
  const session = discuss
    .records()
    .find((entry) => entry.ownership?.kind === owner.kind && entry.ownership.issueId === owner.issueId);
  if (session) mergeHistory(discuss, session, ordinaryMessages(discuss, report));
  return discuss.view(session?.id, owner);
}

function legacyMessages(investigations, owner) {
  return [...investigations.sessions.values()]
    .filter((entry) => entry.issueId === owner.issueId)
    .flatMap((entry) =>
      (entry.messages || []).map((message, index) => ({
        id: 'historical-' + entry.id + '-' + index,
        role: message.role,
        text: message.text,
        status: 'historical',
        attachments: [],
        events: [],
        createdAt: message.at || entry.createdAt,
        investigationContext: { issueId: owner.issueId, attemptId: entry.attemptId },
      }))
    );
}

export async function reportDiscussionAction(discuss, investigations, report, input) {
  const owner = ownership(report);
  const existing = reportDiscussionView(discuss, report).selected;
  requireThat(
    !['close', 'delete-note'].includes(input.action),
    'Investigation discussion remains attached to its reports.'
  );
  const messages = [...ordinaryMessages(discuss, report), ...legacyMessages(investigations, owner)].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt))
  );
  if (existing) mergeHistory(discuss, existing, messages);
  return discuss.action(discussionInput(input, existing, owner), {
    ownership: owner,
    messages,
    reportContext: {
      reportId: report.id,
      title: report.title,
      publishedAt: report.publishedAt,
      source: report.source,
      outputAttemptId: report.attemptId,
      content: report.content,
      evidence: report.evidence,
    },
  });
}

function discussionInput(input, existing, owner) {
  return {
    ...input,
    conversationId: existing?.id || input.conversationId,
    ...(input.action === 'create' ? { requestId: 'investigation-' + owner.issueId } : {}),
  };
}
