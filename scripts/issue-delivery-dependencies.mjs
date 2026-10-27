import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './factory-ui/common.mjs';

// Match the verifier's dependency reuse boundary; never silently install a new lock.
export function linkDeliveryDependencies(root, checkout) {
  if (!existsSync(join(root, 'node_modules')) || existsSync(join(checkout, 'node_modules'))) return;
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    requireThat(
      readFileSync(join(root, file), 'utf8') === readFileSync(join(checkout, file), 'utf8'),
      'Install matching dependencies in the issue checkout before checking its changed lockfile.'
    );
  }
  symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  const workspaces = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    .split('\n')
    .map((line) => line.match(/^\s+-\s+['"]?([^'"#\s]+)['"]?\s*$/)?.[1])
    .filter(Boolean);
  for (const workspace of workspaces) {
    const installed = join(root, workspace, 'node_modules'),
      target = join(checkout, workspace, 'node_modules');
    if (existsSync(installed) && !existsSync(target)) symlinkSync(installed, target, 'dir');
  }
}
