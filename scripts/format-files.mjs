import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export function formattingFiles(checkout, names) {
  return [...new Set(names)].filter((name) => lstatSync(join(checkout, name), { throwIfNoEntry: false })?.isFile());
}

export const formatArgs = (names) => ['--no-error-on-unmatched-pattern', ...names.map((name) => './' + name)];
