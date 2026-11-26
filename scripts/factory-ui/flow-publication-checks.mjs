import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import plan from '../flow-integration-tests.json' with { type: 'json' };
import { digest, git, writeJson } from './common.mjs';
import { normalizeFocusedTests } from '../verify-merge-checks.mjs';
import { candidateBrowserTestPolicy } from './candidate-browser-scenarios.mjs';

const affectedPaths = [
  /^scripts\/flow-integration-tests\.json$/,
  /^scripts\/(?:browser-scenario-policy|flow-browser|flow-browser-(?:issue-annotations|master-issues))\.mjs$/,
  /^scripts\/(?:shared-issue-queue|project-stores-flow|issue-annotations|flow-grouping)\.check\.mjs$/,
  /^scripts\/factory-ui\/(?:flow-(?:service|delivery|executor|publication-checks|group[^/]*|ui)\.(?:mjs|js)|flow\.(?:html|css)|index\.html)$/,
  /^scripts\/factory-ui\/(?:issue-(?:annotations|badges|group[^/]*|run-tools)\.[^/]+|shared-issue-[^/]+|stores\/[^/]+)$/,
];

function affectsFlowPublication(checkout, { base, head }) {
  const paths = git(checkout, 'diff', '--name-only', '--no-renames', '-z', base, head).split('\0');
  return paths.some((path) => affectedPaths.some((pattern) => pattern.test(path)));
}

export async function checkFlowPublication(ctx, checkout, candidate, folder, execute) {
  if (!affectsFlowPublication(checkout, candidate)) return [];
  const path = join(folder, 'flow-publication-checks.json');
  const results = [];
  const evidence = () => ({ path, label: 'Focused Flow publication checks', sha256: digest(readFileSync(path)) });
  const save = (result) => {
    results.push(result);
    writeJson(path, { head: candidate.head, base: candidate.base, results });
  };
  const browserPolicy = candidateBrowserTestPolicy(checkout, candidate.head);
  const validate = (command) => normalizeFocusedTests([command], browserPolicy);
  for (const test of plan.tests) {
    await runPublicationCheck({ ctx, checkout, folder, execute, validate }, test, results.length + 1).then(
      save,
      (error) => {
        save(error.check);
        error.evidence = [evidence(), ...(error.evidence ?? [])];
        throw error;
      }
    );
  }
  return [evidence()];
}

async function runPublicationCheck({ ctx, checkout, folder, execute, validate }, { name, command }, index) {
  const [bin, ...args] = command;
  const log = join(folder, `flow-publication-${index}.log`);
  writeFileSync(log, '', { mode: 0o600 });
  const result = (status) => ({ name, command, status, log: { path: log, sha256: digest(readFileSync(log)) } });
  try {
    validate(command);
    await execute({
      command: bin === 'node' ? process.execPath : bin,
      args,
      cwd: checkout,
      log,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]),
      onProgress: ctx.onProgress,
    });
    return result('passed');
  } catch (error) {
    if (!readFileSync(log).length) writeFileSync(log, error.message + '\n', { mode: 0o600 });
    error.check = result('failed');
    throw error;
  }
}
