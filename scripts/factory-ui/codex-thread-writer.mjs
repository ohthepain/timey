import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const options = { timeout: 1500, maxBuffer: 8192 };

export const isCodexWriterConflict = (message) => /already has an active writer/i.test(message);

export function threadLockedMessage(owner = 'another Codex session') {
  return `This conversation is locked by ${owner}.`;
}

export async function desktopThreadWriter(threadId, { platform = process.platform, execute = run } = {}) {
  if (platform !== 'darwin' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(threadId)) return;
  const command = await writerCommand(threadId, execute).catch(() => '');
  if (command.endsWith('/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'))
    return 'the ChatGPT desktop app';
}

async function writerCommand(threadId, execute) {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const path = join(home, 'thread-writer-locks', `${threadId}.lock`);
  const { stdout } = await execute('/usr/sbin/lsof', ['-nP', '-Fp', path], options);
  const pids = [...stdout.matchAll(/^p([1-9]\d*)$/gm)].map(([, pid]) => pid);
  if (pids.length !== 1) return '';
  const { stdout: command } = await execute('/bin/ps', ['-ww', '-p', pids[0], '-o', 'comm='], options);
  return command.trim();
}
