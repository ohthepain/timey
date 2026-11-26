import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, requireThat } from './common.mjs';

export function githubCheckRuns(repository, checks) {
  const prefix = `https://github.com/${repository}/actions/runs/`;
  return checks.flatMap((check) => checkRun(prefix, check));
}

function runAddress({ detailsUrl, targetUrl, url }) {
  return detailsUrl ?? targetUrl ?? url;
}

function checkRun(prefix, check) {
  const url = runAddress(check);
  const ids = runIds(prefix, url);
  return ids ? [{ ...ids, url, name: check.name ?? check.context }] : [];
}

function runIds(prefix, url) {
  if (!url?.startsWith(prefix)) return;
  const match = /^(\d+)(?:\/job\/(\d+))?(?:[/?#]|$)/.exec(url.slice(prefix.length));
  if (match) return { runId: match[1], jobId: match[2] };
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
  let summaries = [];
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
    summaries = retainSummaries(folder).filter((path) =>
      JSON.parse(readFileSync(path, 'utf8')).checks.some((check) => !check.passed)
    );
  } catch (error) {
    writeFileSync(join(folder, 'artifact-download-error.txt'), error.message);
  }
  const evidence = [];
  try {
    const log = await provider.gh(['run', 'view', id, '--repo', provider.config.repository, '--log-failed']);
    requireThat(log.trim(), 'GitHub did not return failed job output.');
    const path = join(folder, 'failed-job.log');
    writeFileSync(path, log, { mode: 0o600 });
    evidence.push({ path, sha256: digest(log), label: 'Failed GitHub job output' });
  } catch (error) {
    if (!summaries.length) throw error;
  }
  return { summaries, evidence, run: { head: run.head_sha, runId: id, attempt: run.run_attempt } };
}

export async function retainGitHubFailure(provider, error, head, root) {
  const checks = githubCheckRuns(provider.config.repository, error.githubChecks ?? []);
  const ids = [...new Set(checks.map(({ runId }) => runId))];
  const results = await Promise.all(
    ids.map((id) => {
      const folder = join(root, '.issues/evidence', 'github-failure-' + id + '-' + randomUUID());
      return runEvidence(provider, id, head, folder);
    })
  );
  const summaries = results.flatMap((result) => result.summaries);
  error.githubRuns = results.map(({ run }) => ({
    ...run,
    checks: checks.filter((check) => check.runId === run.runId),
  }));
  error.evidence = [...(error.evidence || []), ...results.flatMap((result) => result.evidence)];
  if (summaries.length) {
    error.verificationFailure = { summaries };
  }
}
