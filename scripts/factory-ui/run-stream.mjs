import { existsSync, readFileSync } from 'node:fs';
import { recordActivity } from './activity.mjs';

export function retainStreamEvent(run, item) {
  recordActivity(run, item);
  run.events.push(item);
  if (run.events.length > 150) run.events.shift();
}
export function recoverStream(run, path) {
  if (!Number.isSafeInteger(run.streamOffset) || !existsSync(path)) return;
  const bytes = readFileSync(path);
  if (run.streamOffset > bytes.length)
    throw Error('The saved output log is shorter than its checkpoint. Preserve it before continuing.');
  const tail = bytes.subarray(run.streamOffset).toString('utf8');
  const complete = tail.lastIndexOf('\n') + 1;
  for (const line of tail.slice(0, complete).split('\n').filter(Boolean)) retainStreamEvent(run, JSON.parse(line));
  run.streamOffset += Buffer.byteLength(tail.slice(0, complete));
}
