import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { redactValue } from './activity.mjs';

const explanations = [
  [
    /\bnon-fast-forward\b|\(fetch first\)/i,
    'The remote branch has commits this checkout does not have. Bring those commits into the issue branch before retrying the push.',
  ],
  [
    /\bprotected branch\b|\bGH006\b|\bGH013\b/i,
    'GitHub rejected the change because a branch rule was not met. The log shows which rule blocked it.',
  ],
  [
    /^CONFLICT \(/im,
    'Git could not combine changes automatically. The log names the files that need a resolution in the issue checkout.',
  ],
  [
    /permission denied \(publickey\)|authentication failed|could not read Username/i,
    'Git could not sign in to the remote. Check the credentials for this checkout, then retry.',
  ],
  [
    /ERR_PNPM_OUTDATED_LOCKFILE/i,
    'The dependency lockfile and package manifests disagree. Update and commit the lockfile before retrying.',
  ],
];

function commandError(output) {
  const lines = redactValue(output)
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const errors = lines.filter((line) =>
    /\b(?:fatal|error|exception|assertionerror|conflict|failed|failure|rejected|denied|ERR_[A-Z_]+)\b/i.test(line)
  );
  const original = (errors.length ? errors : lines).slice(-12).join('\n').slice(-4000);
  const explanation = explanations.find(([pattern]) => pattern.test(original))?.[1];
  return { original, explanation };
}

export function commandLogError(path) {
  const descriptor = openSync(path, 'r');
  try {
    const { size } = fstatSync(descriptor);
    const tail = Buffer.alloc(Math.min(size, 32 * 1024));
    const length = readSync(descriptor, tail, 0, tail.length, size - tail.length);
    return commandError(tail.toString('utf8', 0, length));
  } finally {
    closeSync(descriptor);
  }
}
