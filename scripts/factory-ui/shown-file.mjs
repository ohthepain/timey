import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { requireThat } from './common.mjs';

const maxBytes = 2 * 1048576;

// A filename the issue screen already showed. Read-only, and only inside this project.
export function readShownFile(project, input) {
  requireThat(
    typeof input === 'string' && input.length > 0 && input.length < 8192 && !input.includes('\0'),
    'Choose a file shown for this project.'
  );
  let descriptor;
  try {
    const root = realpathSync(project);
    const candidate = isAbsolute(input) ? input : join(root, input);
    let listed;
    try {
      listed = lstatSync(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('The file is missing. Refresh the issue and try again.');
      throw error;
    }
    requireThat(!listed.isSymbolicLink(), 'The file cannot be a symlink.');
    requireThat(
      listed.isFile(),
      listed.isDirectory() ? 'Choose a file, not a folder.' : 'Choose a regular file from this project.'
    );
    const file = realpathSync(candidate);
    const child = relative(root, file);
    requireThat(child && !child.startsWith('..') && !isAbsolute(child), 'The file must be inside this project.');
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    requireThat(info.isFile(), 'Choose a regular file from this project.');
    requireThat(info.size < maxBytes, 'The file must be smaller than 2 MB.');
    const raw = readFileSync(descriptor);
    let nulls = 0;
    for (const byte of raw) if (byte === 0) nulls += 1;
    requireThat(raw.length === 0 || nulls * 20 < raw.length, 'This file is not text.');
    return { path: child.split('\\').join('/'), content: raw.toString('utf8').replaceAll('\0', '\uFFFD') };
  } catch (error) {
    if (error.code === 'ENOENT') throw Error('The file is missing. Refresh the issue and try again.');
    if (error.code === 'ELOOP') throw Error('The file cannot be a symlink.');
    if (error.code)
      throw Error('The file could not be read. Check that it is a readable text file inside this project.');
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
