import { approvalActivity } from './approval-activity.mjs';
import { openSync, closeSync, readSync, fstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { redactValue } from './activity.mjs';
import { requireThat } from './common.mjs';

// Byte cursors address complete JSONL boundaries, so appends cannot shift earlier pages.
export function outputHistory(store, id, before) {
  const run = store.runs.find((entry) => entry.id === id);
  requireThat(run, 'This saved run no longer exists.');
  const path = join(store.directory, `${run.id}.jsonl`);
  if (!existsSync(path)) return { events: [], before: 0, available: false };
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const end = before === null || before === undefined || before === '' ? size : Number(before);
    requireThat(Number.isSafeInteger(end) && end >= 0 && end <= size, 'Invalid output history cursor.');
    if (end < size && end > 0) {
      const boundary = Buffer.alloc(1);
      readSync(fd, boundary, 0, 1, end - 1);
      requireThat(boundary[0] === 10, 'Invalid output history boundary.');
    }
    let start = end;
    let bytes = Buffer.alloc(0);
    do {
      const length = Math.min(65536, start);
      start -= length;
      const block = Buffer.alloc(length);
      readSync(fd, block, 0, length, start);
      bytes = Buffer.concat([block, bytes]);
    } while (start > 0 && (bytes.indexOf(10) < 0 || bytes.indexOf(10) >= bytes.length - 1));
    const cut = start > 0 ? bytes.indexOf(10) + 1 : 0;
    const events = bytes
      .subarray(cut)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { events: redactValue(events.filter(publicEvent).map(publicFields)), before: start + cut, available: true };
  } finally {
    closeSync(fd);
  }
}
function publicEvent(event) {
  const item = event.params?.item;
  if (item && !['agentMessage', 'commandExecution', 'fileChange'].includes(item.type)) return false;
  return [
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'item/commandExecution/outputDelta',
    'turn/started',
    'turn/completed',
    'ui/approval',
    'ui/transportPhase',
    'ui/unsupportedRequest',
    'item/autoApprovalReview/started',
    'item/autoApprovalReview/completed',
  ].includes(event.method);
}

function publicFields(event) {
  const approval = approvalActivity(event);
  if (approval)
    return {
      at: event.at,
      method: event.method,
      params: { threadId: event.params.threadId, reviewId: event.params.reviewId, item: approval },
    };
  if (event.params?.turn) {
    // Terminal notifications may repeat items, including private reasoning.
    // Public item events above already retain the corresponding visible output.
    const { items, ...turn } = event.params.turn;
    return { ...event, params: { ...event.params, turn } };
  }
  return event;
}
