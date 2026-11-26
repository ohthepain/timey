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

export async function desktopThreadWriter(threadId) {
  if (process.platform !== 'darwin' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(threadId)) return;
  const command = await writerCommand(threadId).catch(() => '');
  if (command.endsWith('/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'))
    return 'the ChatGPT desktop app';
}

async function writerCommand(threadId) {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const path = join(home, 'thread-writer-locks', `${threadId}.lock`);
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-Fp', path], options);
  const [, pid] = stdout.trim().match(/^p([1-9]\d*)$/) ?? [];
  if (!pid) return '';
  const { stdout: command } = await run('/bin/ps', ['-ww', '-p', pid, '-o', 'comm='], options);
  return command.trim();
}
