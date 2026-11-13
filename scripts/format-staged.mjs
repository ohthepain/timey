import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
  cwd: root,
  encoding: 'buffer',
})
  .toString()
  .split('\0')
  .filter(Boolean);

if (files.length === 0) process.exit(0);

const snapshot = mkdtempSync(join(tmpdir(), 'timey-format-staged-'));
try {
  const stagedFiles = files.map((file) => {
    const destination = join(snapshot, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, execFileSync('git', ['show', `:${file}`], { cwd: root, encoding: 'buffer' }));
    return destination;
  });
  const result = spawnSync('pnpm', ['exec', 'vp', 'fmt', '--check', ...stagedFiles], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(snapshot, { recursive: true, force: true });
}
