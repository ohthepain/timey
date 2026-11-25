import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import flowIntegration from '../.github/flow-integration-tests.json' with { type: 'json' };
import { normalizeFocusedTests } from './verify-merge-checks.mjs';

const manifest = '.github/pr-repair-tests.json';
const args = process.argv.slice(2);
const base = args[0] === '--base' ? args[1] : undefined;
if (base && !execFileSync('git', ['diff', '--name-only', base, 'HEAD', '--', manifest], { encoding: 'utf8' }).trim()) {
  console.log('No changed PR repair test plan.');
} else {
  const plan = JSON.parse(readFileSync(manifest, 'utf8'));
  const tests = plan.suite === 'flow-integration' ? flowIntegration.tests : plan.tests;
  if (plan.version !== 1 || !Array.isArray(tests) || !tests.length || tests.length > 20)
    throw Error('Record 1–20 named PR repair tests using manifest version 1.');
  for (const test of tests) {
    if (typeof test.name !== 'string' || !test.name.trim() || /[\r\n]/.test(test.name))
      throw Error('Each PR repair test needs a single-line name.');
    normalizeFocusedTests([test.command]);
  }
  for (const test of tests) {
    console.log('RUN PR repair: ' + test.name);
    const [command, ...argv] = test.command;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(command, argv, { stdio: 'inherit', timeout: 120_000, env });
    if (result.error || result.status !== 0) {
      console.error('FAIL PR repair: ' + test.name);
      if (result.error) console.error(result.error.message);
      process.exit(result.status || 1);
    }
    console.log('PASS PR repair: ' + test.name);
  }
}
