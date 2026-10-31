import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat, writeJson } from './common.mjs';

export function conversationFiles(root, issueId) {
  requireThat(typeof issueId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(issueId), 'Select a valid issue.');
  const directory = join(root, '.issues/conversations', issueId);
  return {
    directory,
    log: join(directory, 'messages.jsonl'),
    state: join(directory, 'chat.json'),
    context: join(directory, 'context.json'),
  };
}
export function conversationMessages(root, issueId) {
  const { log } = conversationFiles(root, issueId);
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export function appendMessage(root, issueId, message) {
  const previous = conversationMessages(root, issueId).find((entry) => entry.id === message.id);
  if (previous) {
    requireThat(
      previous.body === message.body && previous.kind === message.kind,
      'This message ID already contains different text.'
    );
    return previous;
  }
  const { directory, log } = conversationFiles(root, issueId);
  mkdirSync(directory, { recursive: true });
  const entry = { ...message, at: message.at || new Date().toISOString() };
  appendFileSync(log, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return entry;
}
export function conversationState(root, issueId) {
  const { state } = conversationFiles(root, issueId);
  if (!existsSync(state)) return { version: 1, issueId, status: 'idle' };
  const saved = JSON.parse(readFileSync(state, 'utf8'));
  requireThat(saved.version === 1 && saved.issueId === issueId, 'Reconcile the saved issue chat; it was not reset.');
  return saved;
}
export function saveConversationState(root, issueId, state) {
  const files = conversationFiles(root, issueId);
  mkdirSync(files.directory, { recursive: true });
  writeJson(files.state, { ...state, version: 1, issueId });
}
