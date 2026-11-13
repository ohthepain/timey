import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
  cwd: root,
  encoding: 'buffer',
})
  .toString()
  .split('\0')
  .filter(Boolean);

if (files.length === 0) process.exit(0);

// Keep snapshot paths inside the checkout. The formatter excludes files outside
// its project root, which made staged issue reports fail or escape formatting.
const snapshotId = randomUUID();
const snapshotFiles = [];
try {
  const stagedFiles = files.map((file, index) => {
    const destination = join(root, `.timey-format-staged-${snapshotId}-${index}-${file.split('/').at(-1)}`);
    writeFileSync(destination, execFileSync('git', ['show', `:${file}`], { cwd: root, encoding: 'buffer' }));
    snapshotFiles.push(destination);
    return destination;
  });
  const formatter = join(root, 'node_modules', '.bin', 'vp');
  const result = spawnSync(formatter, ['fmt', '--check', ...stagedFiles], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const file of snapshotFiles) rmSync(file, { force: true });
}
