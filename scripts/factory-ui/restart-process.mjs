import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnvironment } from './common.mjs';
import { factoryEntry } from './ui-source.mjs';
import { factoryReportFlags } from './heap-crash.mjs';

export function handoffRestart(service, server) {
  const port = server.address().port;
  const log = join(service.store.directory, 'server-restart.log');
  const fd = openSync(log, 'a', 0o600);
  const entry = factoryEntry(service);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...factoryReportFlags,
        entry,
        '--project',
        service.root,
        '--port',
        String(port),
        '--after-pid',
        String(process.pid),
      ],
      { cwd: process.cwd(), env: cleanEnvironment(), detached: true, stdio: ['ignore', fd, fd] }
    );
    closeSync(fd);
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      service.close();
      server.closeAllConnections();
      server.close(() => process.exit(0));
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

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
