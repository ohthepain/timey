import { createHash } from 'node:crypto';
import { beginActivity, diagnosticContext } from './diagnostic-activity.mjs';

const tokenFields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'];
const outputEvents = new Set([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
]);

function tokenCounts(data) {
  return Object.fromEntries(tokenFields.map((field) => [field, validCount(data?.[field])]));
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function difference(total, baseline) {
  return Object.fromEntries(tokenFields.map((field) => [field, tokenDifference(total[field], baseline[field])]));
}

function tokenDifference(total, baseline) {
  if (total === null || baseline === null) return null;
  return Math.max(0, total - baseline);
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function inputPart(kind, value) {
  const serialized = JSON.stringify(value);
  return { kind, hash: hash(serialized), bytes: Buffer.byteLength(serialized) };
}

const promptSections = new Map([
  ['details', 'Issue details'],
  ['notes', 'Block notes'],
  ['sourceIssue', 'Source issue evidence'],
  ['subIssues', 'Sub-issue context'],
  ['evidence', 'Verification evidence references'],
  ['failedChecks', 'Failed check details'],
  ['originalWork', 'Original Work prompt'],
]);

function promptParts(prompt) {
  if (!prompt.startsWith('{') || prompt.length > 200000) return [];
  let fields;
  try {
    fields = JSON.parse(prompt);
  } catch {
    return [];
  }
  return [...promptSections].flatMap(([key, label]) => {
    const value = fields[key];
    return value?.length === 0 || value == null ? [] : [inputPart(label, value)];
  });
}

function isOutput(message) {
  return (
    outputEvents.has(message.method) ||
    (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage')
  );
}

export function meterCodexTurn({ cwd, prompt, extraInput, threadId, thread, settings }) {
  const submitted = [inputPart('Submitted prompt', prompt), ...extraInput.map((part) => inputPart(part.type, part))];
  const parts = [...submitted, ...promptParts(prompt)];
  const record = beginActivity('codex', 'Codex turn', {
    ...diagnosticContext(cwd),
    ...thread,
    ...diagnosticContext(),
    threadId,
    model: settings?.model ?? thread?.model ?? null,
    inputFingerprint: hash(submitted.map((part) => part.hash).join('')),
    inputParts: parts,
  });
  const start = performance.now();
  let firstOutputMs;
  let baseline;
  let usage;
  let finished = false;
  let dispatchRetries = 0;
  return {
    event(message) {
      if (isOutput(message)) firstOutputMs ??= performance.now() - start;
      if (message.method !== 'thread/tokenUsage/updated') return;
      const snapshot = message.params?.tokenUsage;
      if (!snapshot) return;
      const latest = tokenCounts(snapshot.total);
      const last = tokenCounts(snapshot.last);
      baseline ??= difference(latest, last);
      usage = snapshot.total ? difference(latest, baseline) : last;
    },
    retry() {
      dispatchRetries++;
    },
    finish(status) {
      if (finished) return;
      finished = true;
      record(status, { firstOutputMs, usage, dispatchRetries });
    },
  };
}
