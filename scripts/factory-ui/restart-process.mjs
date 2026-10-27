import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnvironment } from './common.mjs';
import { readQueue } from './data.mjs';
import { progressBasis } from './next-action.mjs';
import { factoryEntry } from './ui-source.mjs';

export function handoffRestart(service, server) {
  const port = server.address().port;
  const log = join(service.store.directory, 'server-restart.log');
  const fd = openSync(log, 'a', 0o600);
  const entry = factoryEntry(service);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [entry, '--project', service.root, '--port', String(port), '--after-pid', String(process.pid)],
      { cwd: process.cwd(), env: cleanEnvironment(), detached: true, stdio: ['ignore', fd, fd] }
    );
    closeSync(fd);
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      service.close();
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      resolve();
    });
  });
}
export async function waitForPrevious(pid) {
  if (!pid) return;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Previous server did not stop. No replacement was started.');
}
export function resumeAfterRestart(service) {
  if (service.reviewMode === 'preview') return;
  const path = join(service.store.directory, 'server-restart.json');
  if (!existsSync(path)) return;
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  if (receipt.previousPid === process.pid) return;
  receipt.resume.forEach((id) => resumeIssue(service, id));
  unlinkSync(path);
}
export function resumeIssue(service, issueId) {
  const record = service.lifecycleRuns[issueId];
  if (!paused(record)) return;
  const queue = readQueue(service.root),
    issue = queue.issues.find((item) => item.id === issueId);
  try {
    service.startLifecycle({ issueId, state: issue.state, issueBasis: progressBasis(queue, issueId) });
  } catch (error) {
    // Preserve normal workflow guards rather than forcing a new attempt.
    console.error(`Saved progress for ${issueId} needs attention: ${error.message}`);
  }
}

function paused(record) {
  return record?.status === 'paused' && !record.input;
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
