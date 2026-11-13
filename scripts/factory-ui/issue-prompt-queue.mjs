import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { conversationFiles } from './conversation-store.mjs';
import { requireThat, writeJson } from './common.mjs';

const prompt = z.object({
  id: z.string(),
  issueId: z.string(),
  text: z.string(),
  mode: z.string(),
  skills: z.array(z.string()).default([]),
  revision: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string(),
  status: z.enum([
    'waiting',
    'preparing',
    'dispatching',
    'accepted',
    'uncertain',
    'completed',
    'interrupted',
    'failed',
    'removed',
  ]),
  original: z.string(),
  generated: z.boolean().optional(),
  stageContext: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  attempt: z
    .object({
      id: z.string(),
      operation: z.enum(['send', 'steer']),
      threadId: z.string(),
      turnId: z.string().nullable(),
      at: z.string(),
    })
    .optional(),
  receipt: z.object({ threadId: z.string(), turnId: z.string(), itemId: z.string().optional() }).optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});
const schema = z.object({
  version: z.literal(1),
  issueId: z.string(),
  revision: z.number().int().nonnegative(),
  paused: z.boolean(),
  nextSequence: z.number().int().nonnegative(),
  entries: z.array(prompt),
  operation: z
    .object({
      id: z.string(),
      kind: z.string(),
      runId: z.string().optional(),
      cancellable: z.boolean(),
      owner: z.string(),
      status: z.string(),
    })
    .nullable(),
  native: z
    .object({ status: z.string(), reason: z.string(), threadId: z.string().optional(), turnId: z.string().optional() })
    .nullable(),
});
const terminal = new Set(['completed', 'interrupted', 'failed', 'removed']);
export function pendingPrompts(queue) {
  return queue.entries.filter((entry) => !terminal.has(entry.status));
}
export function readPromptQueue(root, issueId) {
  const path = conversationFiles(root, issueId).queue;
  if (!existsSync(path))
    return {
      version: 1,
      issueId,
      revision: 0,
      paused: false,
      nextSequence: 0,
      entries: [],
      operation: null,
      native: null,
    };
  const queue = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  requireThat(queue.issueId === issueId, 'The saved prompt queue belongs to another issue.');
  return queue;
}
export function changePromptQueue(root, issueId, change) {
  const queue = readPromptQueue(root, issueId);
  const result = change(queue);
  queue.revision++;
  const files = conversationFiles(root, issueId);
  mkdirSync(files.directory, { recursive: true });
  writeJson(files.queue, schema.parse(queue));
  return result;
}
function promptIdentity(input) {
  return JSON.stringify([
    input.text,
    input.mode,
    input.skills || [],
    input.stageContext || null,
    input.outputSchema || null,
    input.generated === true,
  ]);
}
export function addPrompt(root, input) {
  return changePromptQueue(root, input.issueId, (queue) => {
    const old = queue.entries.find((entry) => entry.id === input.id);
    if (old) {
      requireThat(old.original === promptIdentity(input), 'This message ID already contains different text or skills.');
      return false;
    }
    queue.entries.push({
      ...input,
      skills: input.skills || [],
      original: promptIdentity(input),
      revision: 1,
      sequence: queue.nextSequence++,
      createdAt: new Date().toISOString(),
      status: 'waiting',
    });
    return true;
  });
}
export function waitingPrompt(queue, input) {
  const entry = queue.entries.find((item) => item.id === input.id);
  requireThat(
    entry?.status === 'waiting' && entry.revision === input.revision,
    'This queued prompt changed or is already dispatching. Refresh before changing it.'
  );
  return entry;
}
export function changePrompt(root, issueId, id, change) {
  return changePromptQueue(root, issueId, (queue) => {
    const entry = queue.entries.find((item) => item.id === id);
    requireThat(entry, 'The queued prompt no longer exists.');
    return change(entry, queue);
  });
}
