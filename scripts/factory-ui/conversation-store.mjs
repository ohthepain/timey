import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { requireThat, writeJson } from './common.mjs';
import { readProgress } from '../factory-progress.mjs';

export function conversationFiles(root, issueId) {
  requireThat(typeof issueId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(issueId), 'Select a valid issue.');
  const directory = issueConversationDirectory(root, issueId);
  return {
    directory,
    log: join(directory, 'messages.jsonl'),
    state: join(directory, 'chat.json'),
    context: join(directory, 'context.json'),
    queue: join(directory, 'queue.json'),
  };
}

function issueConversationDirectory(root, issueId) {
  const legacy = join(root, '.issues/conversations', issueId);
  const record = readProgress(root)[issueId];
  const checkout = savedCheckout(record);
  const managedRoot = join(root, '.issues');
  if (typeof checkout !== 'string' || !existsSync(checkout) || !existsSync(managedRoot)) return legacy;
  const canonicalManagedRoot = realpathSync(managedRoot);
  const canonicalCheckout = realpathSync(checkout);
  const checkoutRelative = relative(canonicalManagedRoot, canonicalCheckout);
  if (!checkoutRelative || checkoutRelative === '..' || checkoutRelative.startsWith(`..${sep}`)) return legacy;
  const directory = join(canonicalCheckout, '.issues', 'conversations', issueId);
  if (existsSync(legacy) && resolve(legacy) !== resolve(directory)) {
    mkdirSync(join(directory, '..'), { recursive: true });
    requireThat(
      !existsSync(directory),
      'Issue conversation data exists in both the project and issue folders; reconcile it before continuing.'
    );
    renameSync(legacy, directory);
  }
  return directory;
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
  const saved = readConversationState(state, issueId);
  return nativeConversationState(saved, readProgress(root)[issueId]?.nativeChat);
}
function readConversationState(path, issueId) {
  if (!existsSync(path)) return { version: 1, issueId, status: 'idle' };
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(saved.version === 1 && saved.issueId === issueId, 'Reconcile the saved issue chat; it was not reset.');
  return saved;
}
function nativeConversationState(saved, binding) {
  if (!binding) return saved;
  requireNativeBinding(binding);
  if (binding.status === 'pending') return { ...saved, startup: { status: 'native-pending' } };
  requireThat(
    !saved.threadId || saved.threadId === binding.threadId,
    'The saved issue chat conflicts with its native binding. Reconcile the original chats; no replacement was created.'
  );
  return {
    ...saved,
    threadId: binding.threadId,
    nativeThreadId: binding.threadId,
    startup: { status: 'ready', threadId: binding.threadId },
  };
}
function requireNativeBinding(binding) {
  requireThat(
    binding.version === 1 && ['pending', 'ready'].includes(binding.status),
    'The native chat binding needs reconciliation; it was not reset.'
  );
  if (binding.status === 'ready')
    requireThat(typeof binding.threadId === 'string', 'The native chat identity is missing.');
}
export function saveConversationState(root, issueId, state) {
  const files = conversationFiles(root, issueId);
  mkdirSync(files.directory, { recursive: true });
  const bound = nativeConversationState(state, readProgress(root)[issueId]?.nativeChat);
  writeJson(files.state, { ...bound, version: 1, issueId });
}

function savedCheckout(record = {}) {
  return record.work?.checkout || record.chatCheckout?.checkout;
}
