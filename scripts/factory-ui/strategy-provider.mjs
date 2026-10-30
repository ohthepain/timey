import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { cleanEnvironment, requireThat } from './common.mjs';

// GitHub enforces freshness through strict required checks. Never bypass protection
// or replace that enforcement with a local fetch/lock.
export class StrategyProvider {
  constructor(root, config) {
    this.root = root;
    this.config = config;
  }
  async gh(args) {
    const { stdout } = await exec('gh', args, {
      cwd: this.root,
      env: cleanEnvironment(),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  }
  async inspect(number) {
    requireThat(Number.isSafeInteger(number) && number > 0, 'Return the actual issue PR number.');
    return JSON.parse(await this.gh(['api', `repos/${this.config.repository}/pulls/${number}`]));
  }
  async ready(pr, branch, head) {
    requireThat(
      pr.base?.repo?.full_name === this.config.repository && pr.head?.repo?.full_name === this.config.repository,
      'The PR belongs to a different repository.'
    );
    requireThat(
      pr.base.ref === this.config.target && pr.head.ref === branch && pr.head.sha === head,
      'The PR branch, target or candidate changed. No handoff or merge was recorded.'
    );
    requireThat(
      pr.state === 'open' && !pr.merged_at && !pr.draft && pr.mergeable === true,
      'The issue PR must be open, non-draft and mergeable.'
    );
    requireThat(!pr.auto_merge, 'Disable auto-merge before Full Stop handoff.');
    const [owner, name] = this.config.repository.split('/');
    const enrollment = JSON.parse(
      await this.gh([
        'api',
        'graphql',
        '-f',
        'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}',
        '-f',
        'owner=' + owner,
        '-f',
        'name=' + name,
        '-F',
        'number=' + pr.number,
      ])
    );
    const live = enrollment.data?.repository?.pullRequest;
    requireThat(
      live && !live.autoMergeRequest && !live.mergeQueueEntry,
      'Remove this PR from auto-merge and the merge queue before handoff.'
    );
    const view = JSON.parse(
      await this.gh([
        'pr',
        'view',
        String(pr.number),
        '--repo',
        this.config.repository,
        '--json',
        'reviewDecision,statusCheckRollup,mergeStateStatus',
      ])
    );
    requireThat(
      !['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(view.reviewDecision),
      'The PR is waiting for required human review.'
    );
    requireThat(
      view.mergeStateStatus === 'CLEAN',
      'GitHub reports unfinished checks, conflicts or an out-of-date branch.'
    );
    requireThat(
      (view.statusCheckRollup || []).every((check) =>
        check.__typename === 'StatusContext'
          ? check.state === 'SUCCESS'
          : check.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion)
      ),
      'PR checks are pending or failed. Their real results are retained.'
    );
    return { number: pr.number, url: pr.html_url, head, target: pr.base.sha, checks: view.statusCheckRollup };
  }
  async assertMergeProtection() {
    const path = `repos/${this.config.repository}/branches/${encodeURIComponent(this.config.target)}/protection`;
    const protection = JSON.parse(await this.gh(['api', path]));
    const checks = protection.required_status_checks;
    requireThat(
      checks?.strict === true && (checks.contexts?.length || 0) + (checks.checks?.length || 0) > 0,
      'Full Send needs provider-enforced strict required checks on the target branch. No merge was attempted.'
    );
    requireThat(
      protection.enforce_admins?.enabled === true,
      'Full Send requires branch protection to apply to administrators too. No merge was attempted.'
    );
    return true;
  }
  async merge(number, head) {
    await this.assertMergeProtection();
    const repository = JSON.parse(await this.gh(['api', 'repos/' + this.config.repository]));
    const method = repository.allow_squash_merge
      ? '--squash'
      : repository.allow_merge_commit
        ? '--merge'
        : repository.allow_rebase_merge
          ? '--rebase'
          : null;
    requireThat(method, 'No supported merge method is enabled. No merge was attempted.');
    // REST merges refuse a required merge queue instead of silently enrolling it.
    // The expected SHA is enforced remotely; strict protection enforces the base.
    const merged = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.config.repository}/pulls/${number}/merge`,
        '--method',
        'PUT',
        '-f',
        'sha=' + head,
        '-f',
        'merge_method=' + method.slice(2),
      ])
    );
    requireThat(merged.merged === true, 'The merge was not confirmed. Inspect the existing PR before retrying.');
    const pr = await this.inspect(number);
    requireThat(
      pr.merged_at && pr.head.sha === head && pr.merge_commit_sha === merged.sha,
      'Merge outcome is uncertain. Inspect the existing PR before any retry.'
    );
    return { url: pr.html_url, revision: pr.merge_commit_sha };
  }
}
