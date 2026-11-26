import { redactValue } from './activity.mjs';
import { approvalActivity } from './approval-activity.mjs';
import { turnFailure } from './turn-failure.mjs';

export const chatProgressInstructions =
  'Use short commentary to report developer activity. To set the live line, start a commentary message with "[Progress: Exploring]" (use your own short work label) followed by the current task. Start a commentary message with "[Milestone]" only for a meaningful finding, change, verification result, or resolved blocker. Start a commentary message with "[Blocked]" for a failure that needs attention. Put each update on its own line and keep these markers out of the final reply.';

const commandLabels = [
  [/^(?:(?:rg|grep|find|ls|cat|sed|pwd)|git (?:status|log|diff|show))\b/, 'Exploring'],
  [/^apply_patch\b/, 'Editing'],
  [/^(?:node --test|(?:npm|pnpm|yarn|bun) (?:run )?(?:test|lint|check|verify))\b/, 'Verifying'],
  [/^git restore\b/, 'Recovering'],
];

function commandLabel(command) {
  const source = command.replace(/^\S+\s-[a-z]*c\s+['"]?/, '').trim();
  return commandLabels.find(([pattern]) => pattern.test(source))?.[1] || 'Running commands';
}

function commandEntry(item) {
  const command = item.command ?? item.arguments?.command;
  if (typeof command === 'string') return { command, label: commandLabel(command) };
  return toolEntry(item);
}

function toolEntry({ tool, type }) {
  const command = tool ?? (type === 'fileChange' ? 'Change files' : 'Command');
  return { command, label: fileEditors.has(command) ? 'Editing' : 'Running commands' };
}
const fileEditors = new Set(['Edit', 'Write', 'apply_patch', 'Change files']);

function toolOutput(item) {
  const output = item.aggregatedOutput ?? item.output ?? item.result;
  return typeof output === 'string' ? output : JSON.stringify(output);
}

const outputs = {
  fileChange: ({ changes = [] }) => changes.map(({ path }) => path).join('\n'),
};
function retainCommand(owner, item) {
  const entries = (owner.chatActivity ??= []);
  let entry = entries.find(({ id, kind }) => kind === 'command' && id === item.id);
  if (!entry) {
    entry = { id: item.id, kind: 'command', ...redactValue(commandEntry(item)), output: '' };
    entries.push(entry);
  }
  return entry;
}

function commandActivity(owner, item) {
  const entry = retainCommand(owner, item);
  const output = (outputs[item.type] || toolOutput)(item);
  entry.output = boundedOutput(output ?? entry.output);
  entry.exitCode = item.exitCode ?? entry.exitCode;
}
function boundedOutput(text) {
  return redactValue(text).slice(-4000);
}

function append(owner, entry) {
  const entries = (owner.chatActivity ??= []);
  if (!entries.some(({ id, kind }) => kind === entry.kind && id === entry.id))
    entries.push({ ...entry, text: redactValue(entry.text).trim().slice(0, 1200) });
}

const commentaryPattern = /^\[(?:Progress:\s*([^\]\n]{1,40})|(Milestone|Blocked))\]\s+([\s\S]+)$/i;
const commentaryPrefix = /^\s*\[(?:Progress:|Milestone\]|Blocked\])/i;

export function stripChatProgress(text) {
  return text
    .split('\n')
    .filter((line) => !commentaryPrefix.test(line))
    .join('\n');
}

export function isChatCommentary(item) {
  return item.phase === 'commentary' || commentaryPrefix.test(item.text || '');
}
function commentary(owner, item) {
  const text = item.text?.trim();
  if (!text) return;
  const match = commentaryPattern.exec(text);
  if (match) return recordMarkedCommentary(owner, item.id, match);
  if (item.phase === 'commentary') append(owner, { id: item.id, kind: 'progress', text });
}

function recordMarkedCommentary(owner, id, [, label, marker, text]) {
  append(owner, { id, kind: marker?.toLowerCase() ?? 'progress', label: redactValue(label), text });
}

const recordItems = {
  agentMessage: (owner, item, method) => method === 'item/completed' && commentary(owner, item),
  commandExecution: commandActivity,
  fileChange: commandActivity,
  dynamicToolCall: commandActivity,
  mcpToolCall: commandActivity,
};

function recordItem(owner, { item }, method) {
  recordItems[item?.type]?.(owner, item, method);
}

function outputDelta(owner, { itemId, delta = '' }) {
  const command = owner.chatActivity?.find(({ kind, id }) => kind === 'command' && id === itemId);
  if (command) command.output = boundedOutput(command.output + delta);
}

function approvalResult(owner, params) {
  const approval = approvalActivity({ method: 'item/autoApprovalReview/completed', params });
  if (approval?.status === 'blocked') append(owner, { id: approval.id, kind: 'blocked', text: approval.text });
}

function unsupportedDecision(owner, { requestId }) {
  append(owner, {
    id: requestId || 'unsupported',
    kind: 'blocked',
    text: 'The provider needs an unsupported decision.',
  });
}

function turnCompleted(owner, { turn }) {
  if (turn?.status === 'failed') append(owner, { id: turn.id, kind: 'blocked', text: turnFailure(turn) });
}

const handlers = {
  'item/started': recordItem,
  'item/completed': recordItem,
  'item/commandExecution/outputDelta': outputDelta,
  'item/autoApprovalReview/completed': approvalResult,
  'ui/unsupportedRequest': unsupportedDecision,
  'turn/completed': turnCompleted,
};

function trimCommandOutput(entries) {
  const commands = entries.filter(({ kind }) => kind === 'command');
  let remaining = 24000;
  for (const command of commands.reverse()) {
    command.output = command.output.slice(Math.max(0, command.output.length - remaining));
    remaining -= command.output.length;
  }
}

export function hasChatProgress({ method, params = {} }) {
  if (method === 'item/started' || method === 'item/completed') return Object.hasOwn(recordItems, params.item?.type);
  return Object.hasOwn(handlers, method);
}

export function recordChatProgress(owner, { method, params = {} }) {
  handlers[method]?.(owner, params, method);
  if (owner.chatActivity) trimCommandOutput(owner.chatActivity);
}

const newGroup = () => ({ commands: [], label: 'Working', text: '', agentLabel: false });
const projectEntry = {
  command(projection, entry) {
    const group = projection.group;
    group.commands.push(entry);
    if (!group.agentLabel) group.label = entry.label;
  },
  progress(projection, entry) {
    const group = projection.group;
    group.label = entry.label || group.label;
    group.agentLabel = Boolean(entry.label);
    group.text = entry.text;
  },
  milestone(projection, entry) {
    projection.milestones.push({ ...entry, commands: projection.group.commands });
    projection.group = newGroup();
  },
  blocked(projection, entry) {
    projection.milestones.push(entry);
  },
};
export function chatProgress(entries = []) {
  const projection = { milestones: [], group: newGroup() };
  for (const entry of entries) projectEntry[entry.kind](projection, entry);
  const {
    group: { commands, label, text },
    milestones,
  } = projection;
  return { milestones, commands, label, text };
}

function chatAttempts(block) {
  return (block.attempts || [])
    .filter((attempt) => attempt.chatActivity?.length)
    .map((attempt) => ({ block, attempt, progress: { ...chatProgress(attempt.chatActivity), key: attempt.id } }));
}

export function flowChatProgress(flow, conversation) {
  const messages = [...conversation];
  let live;
  const attempts = [...flow.blocks, ...(flow.retiredBlocks || [])].flatMap(chatAttempts);
  for (const { block, attempt, progress } of attempts) {
    if (inProgress(attempt.status)) live = progress;
    else attachAttemptProgress(messages, block, attempt, progress);
  }
  return { messages: messages.sort((a, b) => a.at.localeCompare(b.at)), live };
}

function inProgress(status) {
  return status === 'running' || status === 'stopping';
}

function attachAttemptProgress(messages, block, attempt, progress) {
  const reply = messages.findLastIndex((entry) => entry.kind === 'flow-block-result' && entry.attemptId === attempt.id);
  if (reply >= 0) {
    messages[reply] = { ...messages[reply], progress };
    return;
  }
  messages.push({
    id: 'activity-' + attempt.id,
    blockId: block.id,
    actor: 'agent',
    at: attempt.endedAt || attempt.startedAt,
    body: attempt.summary || '',
    progress,
    status: attempt.status,
  });
}
