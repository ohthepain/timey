import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { digest, requireThat } from './common.mjs';
import { projectHumanInputPolicy } from './guard.mjs';

const require = createRequire(import.meta.url);
const lifecycleFile = '.issues/triage-labels.md';

export function readProjectSettings(root) {
  const present = existsSync(join(root, lifecycleFile));
  const content = present
    ? readFileSync(join(root, lifecycleFile), 'utf8')
    : readFileSync(join(dirname(require.resolve('@timey/local-issues/package.json')), 'triage-labels.md'), 'utf8');
  return {
    project: basename(root),
    humanInputPolicy: projectHumanInputPolicy(),
    lifecycle: { path: lifecycleFile, present, content, digest: digest(content) },
  };
}

export function initializeProjectLifecycle(service, input) {
  service.ownServer();
  const settings = readProjectSettings(service.root);
  if (settings.lifecycle.present) return settings;
  requireThat(
    input.digest === settings.lifecycle.digest,
    'The configuration preview changed. Reopen Project settings.'
  );
  mkdirSync(join(service.root, '.issues'), { recursive: true });
  try {
    writeFileSync(join(service.root, lifecycleFile), settings.lifecycle.content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readProjectSettings(service.root);
}
