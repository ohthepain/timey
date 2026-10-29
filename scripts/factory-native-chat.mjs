import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProgress, updateProgress } from './factory-progress.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { conversationState } from './factory-ui/conversation-store.mjs';
import { digest, requireThat } from './factory-ui/common.mjs';

const threadPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commandPath = fileURLToPath(import.meta.url);
const shellWord = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function selected(project, issueId) {
  const root = realpathSync(project),
    queue = readQueue(root);
  const issue = queue.issues.find((entry) => entry.id === issueId);
  requireThat(issue, 'Select an existing issue by its full ID.');
  return { root, issue, queue };
}
function view(binding) {
  if (!binding) return { status: 'none' };
  requireThat(
    binding.version === 1 && ['pending', 'ready'].includes(binding.status),
    'The native chat binding needs reconciliation; it was not reset.'
  );
  if (binding.status === 'pending')
    return {
      status: 'pending',
      requestId: binding.requestId,
      summary:
        'The original handoff is pending. Return to the Codex draft and send it; no second creation link was issued.',
    };
  requireThat(threadPattern.test(binding.threadId), 'The saved chat identity is invalid.');
  return { status: 'ready', threadId: binding.threadId, href: `codex://threads/${binding.threadId}` };
}
export function nativeChatStatus(project, issueId) {
  const { root } = selected(project, issueId);
  return view(readProgress(root)[issueId]?.nativeChat);
}
export function prepareNativeChat(project, input) {
  requireThat(input?.mode === 'discuss', 'This handoff proof supports discussion only.');
  const { root, issue, queue } = selected(project, input.issueId);
  let href;
  const record = updateProgress(root, issue.id, (previous) => {
    if (previous.nativeChat) return previous;
    requireThat(
      !previous.workThreadId &&
        !previous.assessmentThreadId &&
        !previous.completionThreadId &&
        !conversationState(root, issue.id).threadId &&
        !['running', 'waiting', 'starting'].includes(previous.status) &&
        !queue.actions.some(
          (a) =>
            a.issues.includes(issue.id) &&
            !['cancelled', 'failed', 'reconciled', 'integrated', 'assembled'].includes(a.status)
        ),
      'This issue has existing work or chats. Reconcile its home chat before creating anything.'
    );
    const body = issue.content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
    requireThat(
      body.split('\n').some((line, index) => index > 0 && line.trim()),
      'Add a description before discussing this issue. A title alone creates no chat.'
    );
    const binding = {
      version: 1,
      status: 'pending',
      requestId: randomUUID(),
      project: root,
      reportDigest: digest(issue.content),
      mode: input.mode,
      createdAt: new Date().toISOString(),
    };
    const command = ['node', commandPath, 'bind', root, issue.id, binding.requestId].map(shellWord).join(' ');
    const prompt = `This is the native home chat for issue ${issue.id} in ${root}. The user chose discussion only. First register this chat by running this local command: ${command}. It reads CODEX_THREAD_ID from this chat's environment. If registration fails, stop and report the error; do not create another chat or implement anything. Then read the issue report from the project and discuss it here. Do not start implementation, other chats, server model conversations, publication, or acceptance. Keep future roles and retros in this same chat. The factory server is not needed for registration. For a handoff test issue, report HANDOFF VERIFIED and the issue ID after registration; do no other work.`;
    href = `codex://new?${new URLSearchParams({ path: root, prompt })}`;
    return { ...previous, nativeChat: binding };
  });
  return href
    ? { ...view(record.nativeChat), href, summary: 'Open Codex, then press Send to register this issue chat.' }
    : view(record.nativeChat);
}
export function bindNativeChat(project, issueId, requestId, threadId = process.env.CODEX_THREAD_ID) {
  requireThat(
    typeof threadId === 'string' && threadPattern.test(threadId),
    'Run registration inside the native Codex chat; CODEX_THREAD_ID is required.'
  );
  const { root, issue } = selected(project, issueId);
  const record = updateProgress(root, issueId, (previous) => {
    requireThat(
      !Object.values(readProgress(root)).some(
        (entry) => entry.issueId !== issueId && entry.nativeChat?.threadId === threadId
      ),
      'This chat already belongs to another issue. No second issue was registered.'
    );
    const binding = previous.nativeChat;
    view(binding);
    requireThat(
      binding && binding.project === root && binding.requestId === requestId,
      'This registration does not match the saved issue handoff.'
    );
    if (binding.status === 'ready') {
      requireThat(
        binding.threadId === threadId,
        'This issue already belongs to another chat. No replacement was registered.'
      );
      return previous;
    }
    requireThat(
      binding.reportDigest === digest(issue.content),
      'The issue changed after handoff. Reconcile the pending request.'
    );
    return { ...previous, nativeChat: { ...binding, status: 'ready', threadId, boundAt: new Date().toISOString() } };
  });
  return view(record.nativeChat);
}
if (process.argv[1] && resolve(process.argv[1]) === commandPath) {
  try {
    const [operation, project, issueId, requestId] = process.argv.slice(2);
    requireThat(
      ['status', 'prepare', 'bind'].includes(operation),
      'Use status, prepare, or bind PROJECT ISSUE [REQUEST].'
    );
    const result =
      operation === 'bind'
        ? bindNativeChat(project, issueId, requestId)
        : operation === 'prepare'
          ? prepareNativeChat(project, { issueId, mode: 'discuss' })
          : nativeChatStatus(project, issueId);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
