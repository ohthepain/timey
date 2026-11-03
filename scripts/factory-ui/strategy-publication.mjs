import { requireThat } from './common.mjs';

// Every retry discovers an existing PR before writing. A lost create response
// must never result in another PR, a personal-login fallback or a reopened PR.
export async function publishStrategyPR(provider, work, head, publication) {
  requireThat(provider.credentials, 'PR publication requires configured GitHub App credentials.');
  const identity = await provider.credentials.session();
  const query = new URLSearchParams({
    state: 'all',
    head: provider.config.repository.split('/')[0] + ':' + work.branch,
    base: provider.config.target,
  });
  const existing = JSON.parse(await provider.gh(['api', `repos/${provider.config.repository}/pulls?${query}`]));
  requireThat(existing.length <= 1, 'Multiple PRs match this issue branch; reconcile them before publication.');
  const pr = existing[0] || (await createPR(provider, work, head, publication));
  assertPublishedPR(provider, pr, work.branch, head, identity.slug);
  return pr;
}

async function createPR(provider, work, head, publication) {
  requireThat(
    publication?.title?.trim() && publication?.body?.trim(),
    'Prepare the PR title and body before publication.'
  );
  const ref = JSON.parse(
    await provider.gh(['api', `repos/${provider.config.repository}/git/ref/heads/${encodeURIComponent(work.branch)}`])
  );
  requireThat(ref.object?.sha === head, 'Push the verified issue candidate before PR publication.');
  return JSON.parse(
    await provider.gh([
      'api',
      `repos/${provider.config.repository}/pulls`,
      '--method',
      'POST',
      '-f',
      'head=' + work.branch,
      '-f',
      'base=' + provider.config.target,
      '-f',
      'title=' + publication.title,
      '-f',
      'body=' + publication.body,
      '-F',
      'draft=false',
    ])
  );
}

function assertPublishedPR(provider, pr, branch, head, slug) {
  requireThat(
    pr.user?.login === slug + '[bot]',
    'This issue PR was opened by a personal account. It cannot be made App-authored in place; preserve it for an explicit replacement decision.'
  );
  assertPRState(pr);
  assertPRCandidate(pr.head, branch, head, provider.config.repository);
  assertPRTarget(pr.base, provider.config);
}

function assertPRState(pr) {
  requireThat(Number.isSafeInteger(pr.number) && pr.number > 0, 'GitHub did not return an actual PR number.');
  requireThat(pr.state === 'open' && pr.draft === false, 'Publication did not return an open, non-draft PR.');
}

function assertPRCandidate(source, branch, head, repository) {
  requireThat(source?.ref === branch && source.sha === head, 'The published PR candidate changed; verify it again.');
  requireThat(source.repo?.full_name === repository, 'The published PR source repository changed.');
}

function assertPRTarget(target, config) {
  requireThat(
    target?.ref === config.target && target.repo?.full_name === config.repository,
    'The published PR target does not match the approved repository and branch.'
  );
}
