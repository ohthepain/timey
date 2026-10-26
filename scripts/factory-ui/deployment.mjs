import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeInfo } from './runtime.mjs';
import { requireThat } from './common.mjs';

export function prepareDeployment(service) {
  service.ownServer();
  for (const lock of ['factory-progress.lock', 'factory-integration.lock'])
    requireThat(
      !existsSync(join(service.root, '.issues', lock)),
      'Wait for the current coordinator operation before deployment.'
    );
  requireThat(!service.issueChats?.tasks.size, 'Wait for issue chat responses before deployment.');
  const snapshot = service.snapshot();
  requireThat(!service.store.connected.size, 'Wait for connected work before deployment.');
  requireThat(!snapshot.runs.some(activeRun), 'Wait for active issue work before deployment.');
  requireThat(
    !snapshot.issues.some((issue) => ['running', 'answering'].includes(issue.lifecycle?.status)),
    'Pause lifecycle Progress before deployment.'
  );
  service.deploymentDraining = true;
  return { ...runtimeInfo(service), pid: process.pid };
}
function activeRun(run) {
  return ['preparing', 'running', 'checking'].includes(run.status);
}
