import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat } from './common.mjs';

function runId(repository, address) {
  try {
    const url = new URL(address);
    const prefix = '/' + repository + '/actions/runs/';
    if (![url.origin === 'https://github.com', url.pathname.startsWith(prefix)].every(Boolean)) return [];
    const id = url.pathname.slice(prefix.length).split('/')[0];
    return /^\d+$/.test(id) ? [id] : [];
  } catch {
    return [];
  }
}

function localCheck(check, folder) {
  const path = join(folder, basename(String(check.log)));
  const present = lstatSync(path, { throwIfNoEntry: false })?.isFile();
  requireThat(check.passed || present, 'The failed GitHub check log is missing from its artifact.');
  return { ...check, log: present ? path : undefined, artifacts: [] };
}

function retainSummaries(folder) {
  return readdirSync(folder)
    .filter((name) => name.endsWith('-summary.json'))
    .map((name, index) => {
      const summary = JSON.parse(readFileSync(join(folder, name), 'utf8'));
      requireThat(Array.isArray(summary.checks), 'The GitHub verification summary has no checks.');
      const path = join(folder, 'repair-summary-' + index + '.json');
      writeFileSync(
        path,
        JSON.stringify({ ...summary, checks: summary.checks.map((check) => localCheck(check, folder)) })
      );
      return path;
    });
}

async function runEvidence(provider, id, head, folder) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const run = JSON.parse(await provider.gh(['api', `repos/${provider.config.repository}/actions/runs/${id}`]));
  requireThat(run.head_sha === head, 'GitHub failure evidence belongs to a different commit.');
  try {
    await provider.gh([
      'run',
      'download',
      id,
      '--repo',
      provider.config.repository,
      '--name',
      'verification-evidence',
      '--dir',
      folder,
    ]);
    const summaries = retainSummaries(folder).filter((path) =>
      JSON.parse(readFileSync(path, 'utf8')).checks.some((check) => !check.passed)
    );
    if (summaries.length) return { summaries, evidence: [] };
  } catch (error) {
    writeFileSync(join(folder, 'artifact-download-error.txt'), error.message);
  }
  const log = await provider.gh(['run', 'view', id, '--repo', provider.config.repository, '--log-failed']);
  const path = join(folder, 'failed-job.log');
  writeFileSync(path, log, { mode: 0o600 });
  return { summaries: [], evidence: [{ path, label: 'Failed GitHub job output' }] };
}

export async function retainGitHubFailure(provider, error, head, checkout) {
  const checks = error.githubChecks || [];
  const ids = [...new Set(checks.flatMap((check) => runId(provider.config.repository, check.url)))];
  const results = await Promise.all(
    ids.map((id) => {
      const folder = join(checkout, '.issues/evidence', 'github-failure-' + id + '-' + randomUUID());
      return runEvidence(provider, id, head, folder);
    })
  );
  const summaries = results.flatMap((result) => result.summaries);
  error.evidence = [...(error.evidence || []), ...results.flatMap((result) => result.evidence)];
  if (summaries.length) {
    error.verificationFailure = { summaries };
  }
}
