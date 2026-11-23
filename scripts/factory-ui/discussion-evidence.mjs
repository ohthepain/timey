import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './common.mjs';

export function writeDiscussionEvidence(directory, name, content) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  writeFileSync(path, content, { mode: 0o600 });
  return { path, characters: content.length, bytes: Buffer.byteLength(content), sha256: digest(content) };
}
