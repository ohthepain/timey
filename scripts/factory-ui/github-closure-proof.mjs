import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { digest, git, requireThat } from './common.mjs';
import { validateSummary } from './checks.mjs';

function runIds(repository, checks) {
  const prefix = '/' + repository + '/actions/runs/';
  return [
    ...new Set(
      checks.flatMap((check) => {
        try {
          const url = new URL(check.detailsUrl || check.url);
          const id = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).split('/')[0] : '';
          return url.origin === 'https://github.com' && /^\d+$/.test(id) ? [id] : [];
        } catch {
          return [];
        }
      })
    ),
  ];
}

function proof(path) {
  return { path, sha256: digest(readFileSync(path)) };
}

function relocatedFile(folder, remoteRoot, path, sha256) {
  requireThat(typeof path === 'string' && path.startsWith(remoteRoot + '/'), 'CI evidence escapes its artifact root.');
  const file = realpathSync(resolve(folder, posix.relative(remoteRoot, path)));
  const within = relative(realpathSync(folder), file);
  requireThat(within && !within.startsWith('..') && !within.startsWith('/'), 'CI evidence escapes its artifact root.');
  requireThat(!sha256 || proof(file).sha256 === sha256, 'A GitHub evidence artifact changed after verification.');
  return file;
}

function relocateSummary(folder, original) {
  const source = JSON.parse(readFileSync(original));
  const remoteRoot = posix.dirname(source.checks[0].log);
  const checks = source.checks.map((check) => ({
    ...check,
    log: relocatedFile(folder, remoteRoot, check.log),
    artifacts: (check.artifacts || []).map((file) => ({
      ...file,
      path: relocatedFile(folder, remoteRoot, file.path, file.sha256),
    })),
  }));
  return { ...source, checks };
}

function supportingProof(summary) {
  return summary.checks.flatMap((check) => [check.log, ...(check.artifacts || []).map((file) => file.path)]).map(proof);
}

function stepEvidence(checkout, base, tree, validate) {
  const directory = join(checkout, '.issues/evidence');
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith('-summary.json'))
    .sort()
    .reverse()) {
    const path = join(directory, name);
    const summary = JSON.parse(readFileSync(path));
    if (summary.checkpoint !== 'step' || summary.base !== base || summary.snapshot_tree !== tree) continue;
    validate(summary, base, tree, { auditPolicy: 'required' });
    return { path, supporting: supportingProof(summary) };
  }
  throw Error('A passing step audit for the merged candidate is required before closing.');
}

async function downloadRun(provider, id, head, directory) {
  const run = JSON.parse(await provider.gh(['api', `repos/${provider.config.repository}/actions/runs/${id}`]));
  requireThat(
    run.head_sha === head && run.status === 'completed' && run.conclusion === 'success',
    'GitHub verification is not successful for this exact candidate.'
  );
  mkdirSync(directory, { recursive: true });
  if (!completeDownload(directory)) {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    await provider.gh([
      'run',
      'download',
      id,
      '--repo',
      provider.config.repository,
      '--name',
      'verification-evidence',
      '--dir',
      directory,
    ]);
  }
  return run;
}

function completeDownload(directory) {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('-summary.json'))
      .some((name) => {
        const summary = relocateSummary(directory, join(directory, name));
        return summary.checkpoint === 'verification' && summary.passed;
      });
  } catch {
    return false;
  }
}

export async function retainGitHubClosureVerification({
  provider,
  delivered,
  workspace,
  folder,
  validate = validateSummary,
}) {
  const head = git(workspace.checkout, 'rev-parse', 'HEAD');
  const tree = git(workspace.checkout, 'rev-parse', 'HEAD^{tree}');
  requireThat(
    delivered.mergedAt && delivered.head === head,
    'Only the exact merged candidate can reuse GitHub verification.'
  );
  const step = stepEvidence(workspace.checkout, workspace.base, tree, validate);
  for (const id of runIds(provider.config.repository, delivered.checks)) {
    const directory = join(workspace.checkout, '.issues/evidence', 'github-closure-' + id);
    const run = await downloadRun(provider, id, head, directory);
    for (const name of readdirSync(directory).filter((name) => name.endsWith('-summary.json'))) {
      const original = join(directory, name);
      const summary = relocateSummary(directory, original);
      if (summary.checkpoint !== 'verification') continue;
      validate(summary, workspace.base, tree, { auditPolicy: 'required' });
      mkdirSync(folder, { recursive: true });
      const path = join(folder, 'github-verification-' + id + '.json');
      writeFileSync(
        path,
        JSON.stringify({
          ...summary,
          importedFrom: { run: run.html_url, head: run.head_sha, original: proof(original) },
        })
      );
      return {
        head,
        tree,
        base: workspace.base,
        uncommitted: false,
        origin: { kind: 'github-actions', run: run.html_url, head: run.head_sha },
        proof: [proof(path), proof(step.path)],
        supportingProof: [proof(original), ...supportingProof(summary), ...step.supporting],
      };
    }
  }
  throw Error('No passing GitHub verification report matches the merged candidate.');
}
