import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const githubAppEnvironmentKeys = [
  'TIMEY_SOFTWARE_FACTORY_GITHUB_APP_ID',
  'TIMEY_SOFTWARE_FACTORY_GITHUB_INSTALL_ID',
  'TIMEY_SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY',
];

export function readProjectEnv(root) {
  const path = join(root, '.env');
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

export function githubAppEnvironment(root) {
  const local = readProjectEnv(root);
  return Object.fromEntries(githubAppEnvironmentKeys.map((key) => [key, process.env[key] ?? local[key]]));
}
