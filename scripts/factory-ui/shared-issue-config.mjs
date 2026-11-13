import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, requireThat } from './common.mjs';

export function sharedIssueQueueEnabled(root) {
  const path = join(root, 'factory.config.json');
  return existsSync(path) && readJson(path).sharedIssueQueue === true;
}

export function sharedIssueQueueConfig(root) {
  if (!sharedIssueQueueEnabled(root)) return null;
  const path = join(root, '.issues/issue-delivery-config.json');
  requireThat(existsSync(path), 'Configure GitHub issue delivery before enabling the shared queue.');
  const config = readJson(path);
  requireThat(
    config.provider === 'github' &&
      /^[\w.-]+\/[\w.-]+$/.test(config.repository || '') &&
      /^[a-zA-Z0-9][\w.-]*$/.test(config.remote || '') &&
      /^[a-zA-Z0-9][\w./-]*$/.test(config.target || ''),
    'The shared queue requires a configured GitHub repository, remote and target branch.'
  );
  return config;
}
