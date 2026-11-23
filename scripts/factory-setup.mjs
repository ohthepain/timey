import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { readProjectEnv, githubAppEnvironmentKeys } from './factory-ui/project-env.mjs';

export function setupFactoryEnv(root, supplied = {}) {
  const path = join(root, '.env');
  const existing = readProjectEnv(root);
  const fields = ['appId', 'installationId', 'privateKey'];
  const values = githubAppEnvironmentKeys.map((key, index) => existing[key] || supplied[fields[index]]);
  for (const [index, label] of [
    [0, 'App ID'],
    [1, 'installation ID'],
  ]) {
    if (!Number.isSafeInteger(Number(values[index])) || Number(values[index]) <= 0)
      throw Error(`Enter a valid GitHub ${label}.`);
  }
  try {
    createPrivateKey(values[2]?.replace(/\\n/g, '\n'));
  } catch {
    throw Error('Supply a valid GitHub App PEM private key.');
  }
  const missing = githubAppEnvironmentKeys.filter((key) => !existing[key]);
  if (missing.length) {
    const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const additions = githubAppEnvironmentKeys.flatMap((key, index) =>
      existing[key] ? [] : [`${key}=${JSON.stringify(String(values[index]).replace(/\\n/g, '\n'))}`]
    );
    writeFileSync(path, original + (original && !original.endsWith('\n') ? '\n' : '') + additions.join('\n') + '\n', {
      mode: 0o600,
    });
    chmodSync(path, 0o600);
  }
  const ignore = join(root, '.gitignore');
  const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (!ignored.split(/\r?\n/).some((line) => ['.env', '/.env', '.env*'].includes(line.trim())))
    writeFileSync(ignore, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + '.env\n');
  return { added: missing.length, path };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'pnpm factory:setup [--project PATH]\nConfigures GitHub App credentials in the project .env. Existing values are preserved.'
    );
    return;
  }
  const index = args.indexOf('--project');
  if (index >= 0 && !args[index + 1]) throw Error('Supply a project path.');
  const root = resolve(index >= 0 ? args[index + 1] : process.cwd());
  const existing = readProjectEnv(root);
  const prompts = createInterface({ input: process.stdin, output: process.stdout });
  const supplied = {};
  try {
    if (!existing[githubAppEnvironmentKeys[0]]) supplied.appId = await prompts.question('GitHub App ID: ');
    if (!existing[githubAppEnvironmentKeys[1]])
      supplied.installationId = await prompts.question('GitHub installation ID: ');
    if (!existing[githubAppEnvironmentKeys[2]]) {
      const path = await prompts.question('PEM private key file path: ');
      try {
        supplied.privateKey = readFileSync(resolve(path.trim()), 'utf8');
      } catch {
        throw Error('Cannot read the specified private key file.');
      }
    }
  } finally {
    prompts.close();
  }
  const result = setupFactoryEnv(root, supplied);
  console.log(
    `Factory credentials configured in ${result.path}. Added ${result.added} missing values. Restart the factory to apply them.`
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
