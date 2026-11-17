import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sep } from 'node:path';
import { requireThat } from './common.mjs';

const run = promisify(execFile);
const pending = new Set();
export async function trashDirectory(path) {
  requireThat(process.platform === 'darwin', 'Moving folders to Trash is available on macOS.');
  await run('/usr/bin/trash', ['-s', path], { timeout: 30000 });
}

export function requireAvailableDirectory(path) {
  requireThat(
    ![...pending].some(
      (directory) => path === directory || path.startsWith(directory + sep) || directory.startsWith(path + sep)
    ),
    'This folder is being moved to Trash. Choose another folder.'
  );
}

export async function whileTrashingDirectory(path, action) {
  requireAvailableDirectory(path);
  pending.add(path);
  try {
    return await action();
  } finally {
    pending.delete(path);
  }
}
