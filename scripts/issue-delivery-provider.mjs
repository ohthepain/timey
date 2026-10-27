import { execFileSync } from 'node:child_process';
import { cleanEnvironment, digest, git, requireThat } from './factory-ui/common.mjs';

// GitHub's documented merge APIs condition only on head SHA. No expected-base
// condition is available here. Never promote a local fetch/lock to that guarantee.
export class GitHubDeliveryProvider {
  constructor(root) {
    this.root = root;
  }
  api(path, method = 'GET', input) {
    return JSON.parse(
      execFileSync('gh', ['api', path, '--method', method, ...(input ? ['--input', '-'] : [])], {
        encoding: 'utf8',
        input: input ? JSON.stringify(input) : undefined,
        env: cleanEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
  }
  ref(request, name) {
    const value = git(this.root, 'ls-remote', '--heads', request.remote, 'refs/heads/' + name);
    return value ? value.split(/\s/)[0] : null;
  }
  findBranch(request) {
    const revision = this.ref(request, request.source);
    requireThat(
      !revision || revision === request.candidate,
      'Remote issue branch changed; preserve it for reconciliation.'
    );
    return revision ? [{ revision }] : [];
  }
  publish(request, checkout) {
    requireThat(
      this.ref(request, request.target) === request.targetRevision,
      'Remote target changed before publication; reassemble and reverify.'
    );
    requireThat(git(checkout, 'rev-parse', 'HEAD') === request.candidate, 'Publication candidate changed.');
    git(
      checkout,
      'push',
      '--force-with-lease=refs/heads/' + request.source + ':',
      request.remote,
      request.candidate + ':refs/heads/' + request.source
    );
    return { revision: request.candidate };
  }
  marker(request) {
    return '<!-- timey-issue-delivery:' + request.issueId + ':' + digest(JSON.stringify(request)) + ' -->';
  }
  canonical(value) {
    return {
      id: value.node_id,
      number: value.number,
      url: value.html_url,
      repository: value.base.repo.full_name,
      source: value.head.ref,
      target: value.base.ref,
      state: value.merged_at ? 'merged' : value.state,
      headRepository: value.head.repo?.full_name,
    };
  }
  findPullRequests(request) {
    const [owner] = request.repository.split('/');
    const pages = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          '--paginate',
          '--slurp',
          `repos/${request.repository}/pulls?state=all&head=${encodeURIComponent(owner + ':' + request.source)}`,
        ],
        { encoding: 'utf8', env: cleanEnvironment(), stdio: 'pipe' }
      )
    );
    const matches = pages.flat().filter((pr) => pr.head.ref === request.source);
    for (const pr of matches)
      requireThat(
        pr.head.repo?.full_name === request.repository &&
          pr.base.ref === request.target &&
          pr.body?.includes(this.marker(request)),
        'Existing issue PR has different scope or operation identity; reconcile it.'
      );
    return matches.map((pr) => this.canonical(pr));
  }
  open(request, title) {
    requireThat(
      this.ref(request, request.source) === request.candidate &&
        this.ref(request, request.target) === request.targetRevision,
      'Remote source or target changed before opening.'
    );
    return this.canonical(
      this.api(`repos/${request.repository}/pulls`, 'POST', {
        title,
        head: request.source,
        base: request.target,
        body: `${this.marker(request)}\nComplete issue ${request.issueId}.\nContributing actions: ${request.contributions.join(', ')}\nCandidate: ${request.candidate}\nTarget tested: ${request.targetRevision}\nCompletion and verification records remain in the factory delivery evidence. Human acceptance is separate.`,
        draft: false,
      })
    );
  }
  observe(request, pr) {
    const raw = this.api(`repos/${request.repository}/pulls/${pr.number}`);
    let protection = null;
    try {
      protection = this.api(
        `repos/${request.repository}/branches/${encodeURIComponent(request.target)}/protection/required_status_checks`
      );
    } catch {
      /* Missing policy stays unavailable. */
    }
    return {
      pr: this.canonical(raw),
      candidate: raw.head.sha,
      target: this.ref(request, request.target),
      mergeable: raw.mergeable === true,
      reviewsResolved: false,
      checks: [],
      policy: protection
        ? { trusted: true, source: 'GitHub branch protection', required: protection.contexts, raw: protection }
        : null,
      capability: {
        expectedHeadAndTarget: false,
        reason:
          'GitHub REST merge accepts an expected head SHA but no expected target SHA. Automatic merging is disabled. Configure and implement a verified merge-queue contract before enabling it.',
      },
    };
  }
  findMerge(request, pr) {
    const raw = this.api(`repos/${request.repository}/pulls/${pr.number}`);
    requireThat(
      raw.node_id === pr.id &&
        raw.head.sha === request.candidate &&
        raw.head.repo?.full_name === request.repository &&
        raw.base.repo.full_name === request.repository &&
        raw.base.ref === request.target,
      'PR identity changed during merge recovery.'
    );
    if (!raw.merged) return [];
    const commit = this.api(`repos/${request.repository}/git/commits/${raw.merge_commit_sha}`);
    return [{ revision: raw.merge_commit_sha, tree: commit.tree.sha, prId: pr.id }];
  }
  merge() {
    throw Error('GitHub expected-target conditional merge is unavailable. No merge was attempted.');
  }
  fetchMerge(request, merge, root) {
    git(root, 'fetch', request.remote, 'refs/heads/' + request.target);
    git(root, 'merge-base', '--is-ancestor', merge.revision, 'FETCH_HEAD');
    requireThat(git(root, 'rev-parse', merge.revision + '^{tree}') === merge.tree, 'Remote merged tree changed.');
  }
}
