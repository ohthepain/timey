import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

export async function listenerPreflight(createListener = createServer) {
  return new Promise((resolve, reject) => {
    const server = createListener();
    server.once('error', (error) =>
      reject(
        Object.assign(
          Error(
            `Execution preflight: localhost listener unavailable (${error.code}). Run verification in an environment allowed to bind 127.0.0.1; no checks were run.`
          ),
          { code: 'PREFLIGHT_LISTENER' }
        )
      )
    );
    server.listen(0, '127.0.0.1', () => server.close(resolve));
  });
}
export function dependencyPreflight(root, snapshot, workspaces) {
  const installed = join(root, 'node_modules/.pnpm/lock.yaml');
  if (!existsSync(installed))
    throw Error(
      `Execution preflight: installed dependency lock missing: ${installed}. Run pnpm install --frozen-lockfile in this checkout.`
    );
  // pnpm 12 may prepend a package-manager lock as the first YAML document.
  const wanted = readFileSync(join(snapshot, 'pnpm-lock.yaml'), 'utf8')
    .split(/(?:^|\n)---\s*\n/)
    .filter(Boolean)
    .at(-1);
  if (wanted !== readFileSync(installed, 'utf8'))
    throw Error(
      'Execution preflight: installed dependencies do not match the snapshot lockfile. Run pnpm install --frozen-lockfile in this checkout.'
    );
  for (const workspace of workspaces) {
    const path = join(root, workspace, 'node_modules');
    if (!existsSync(path))
      throw Error(
        `Execution preflight: workspace dependencies missing: ${path}. Run pnpm install --frozen-lockfile in this checkout.`
      );
  }
}
