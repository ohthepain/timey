import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { cleanEnvironment, requireThat } from './common.mjs';
import { githubAppCredentials } from './github-app.mjs';
import { assertChecks, inspectReadiness, latestChecks } from './strategy-readiness.mjs';
import { infrastructureFailure, repairableBlocker } from './strategy-repair.mjs';
import { findStrategyPR, publishStrategyPR } from './strategy-publication.mjs';

// GitHub enforces freshness through strict required checks. A verified ruleset
// review bypass never bypasses CI or replaces server enforcement with a local lock.
export class StrategyProvider {
  constructor(root, config, credentialRoot = root) {
    this.root = root;
    this.config = config;
    this.credentials = githubAppCredentials(credentialRoot, config.repository);
  }
  async gh(args) {
    const env = cleanEnvironment();
    const session = this.credentials ? await this.credentials.session() : null;
    if (session) {
      env.GH_TOKEN = session.token;
      env.GH_HOST = 'github.com';
      delete env.GH_DEBUG;
      delete env.GITHUB_TOKEN;
    }
    try {
      const { stdout } = await exec('gh', args, {
        cwd: this.root,
        env,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      throw githubFailure(error, session);
    }
  }

  async inspect(number) {
    requireThat(Number.isSafeInteger(number) && number > 0, 'Return the actual issue PR number.');
    return JSON.parse(await this.gh(['api', `repos/${this.config.repository}/pulls/${number}`]));
  }
  async inspectExternalDelivery(number) {
    requireThat(Number.isSafeInteger(number) && number > 0, 'Enter the pull request number to verify.');
    const pr = await this.inspect(number);
    assertExternalPRState(pr);
    assertExternalPRRepository(pr, this.config.repository);
    assertExternalPRTarget(pr, this.config.target, this.config.repository);
    const comparison = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.config.repository}/compare/${encodeURIComponent(pr.merge_commit_sha)}...${encodeURIComponent(this.config.target)}`,
      ])
    );
    assertCurrentTargetContainsPR(comparison);
    const view = JSON.parse(
      await this.gh([
        'pr',
        'view',
        String(number),
        '--repo',
        this.config.repository,
        '--json',
        'statusCheckRollup,files',
      ])
    );
    const checks = latestChecks(view.statusCheckRollup || []);
    assertChecks(checks);
    assertExternalFiles(view.files);
    return {
      number,
      url: pr.html_url,
      target: pr.base.ref,
      targetRevision: comparison.head_sha,
      head: pr.head.sha,
      mergedAt: pr.merged_at,
      mergeCommit: pr.merge_commit_sha,
      checks,
      files: view.files.map((file) => file.path),
    };
  }
  async publish(work, head, publication) {
    return publishStrategyPR(this, work, head, publication);
  }
  async findByBranch(branch, target) {
    return findStrategyPR(this, branch, target);
  }
  async ready(pr, branch, head) {
    return inspectReadiness(this, pr, branch, head, () => this.canBypassOwnReview(pr));
  }
  async canBypassOwnReview(pr) {
    const [owner] = this.config.repository.split('/');
    if (this.credentials) {
      const identity = await this.credentials.session();
      if (![owner, identity.slug + '[bot]'].includes(pr.user?.login)) return false;
    } else {
      const viewer = JSON.parse(await this.gh(['api', 'user']));
      if (!viewer.login || viewer.login !== owner || pr.user?.login !== viewer.login) return false;
    }
    await this.assertMergeProtection();
    // Classic protection may coexist with rulesets; only its absence is optional.
    try {
      const protection = JSON.parse(
        await this.gh([
          'api',
          `repos/${this.config.repository}/branches/${encodeURIComponent(this.config.target)}/protection`,
        ])
      );
      if (protection.required_pull_request_reviews) return false;
    } catch (error) {
      if (error.githubStatus !== 404 && !/HTTP 404/.test(error.message)) throw error;
    }
    const pages = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.config.repository}/rules/branches/${encodeURIComponent(this.config.target)}?per_page=100`,
        '--paginate',
        '--slurp',
      ])
    );
    const reviewRules = pages.flat().filter((rule) => rule.type === 'pull_request');
    if (!reviewRules.length) return false;
    for (const id of new Set(reviewRules.map((rule) => rule.ruleset_id))) {
      if (!Number.isSafeInteger(id) || id <= 0) return false;
      const ruleset = JSON.parse(await this.gh(['api', `repos/${this.config.repository}/rulesets/${id}`]));
      if (
        ruleset.id !== id ||
        ruleset.enforcement !== 'active' ||
        !['always', 'pull_requests_only'].includes(ruleset.current_user_can_bypass)
      )
        return false;
    }
    return true;
  }
  async assertMergeProtection() {
    const pages = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.config.repository}/rules/branches/${encodeURIComponent(this.config.target)}?per_page=100`,
        '--paginate',
        '--slurp',
      ])
    );
    const rules = pages.flat(),
      rulesetIds = [...new Set(rules.map((rule) => rule.ruleset_id).filter((id) => Number.isSafeInteger(id)))];
    const rulesets = await Promise.all(
      rulesetIds.map(async (id) => JSON.parse(await this.gh(['api', `repos/${this.config.repository}/rulesets/${id}`])))
    );
    const active = rulesets.filter((ruleset) => ruleset.enforcement === 'active');
    const ciRulesets = active.filter((ruleset) =>
      (ruleset.rules || []).some((rule) => rule.type === 'required_status_checks')
    );
    const checks = ciRulesets
      .flatMap((ruleset) => ruleset.rules || [])
      .filter((rule) => rule.type === 'required_status_checks')
      .map((rule) => rule.parameters || {});
    requireThat(
      checks.some(
        (parameters) =>
          parameters.strict_required_status_checks_policy === true &&
          (parameters.required_status_checks?.length || 0) > 0
      ),
      'Full Send needs an active ruleset with strict required checks on the target branch. No merge was attempted.'
    );
    requireThat(
      ciRulesets.every((ruleset) => ruleset.current_user_can_bypass === 'never'),
      'Full Send requires CI rulesets to prevent this credential from bypassing required checks, including administrators. No merge was attempted.'
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

function assertExternalPRState(pr) {
  requireThat(pr.state === 'closed', 'The other pull request must be merged before it can count as delivered.');
  assertExternalMergeTime(pr);
  assertExternalRevisions(pr);
}

function assertExternalMergeTime(pr) {
  requireThat(pr.merged_at, 'The other pull request must be merged before it can count as delivered.');
}

function assertExternalRevisions(pr) {
  requireThat(pr.merge_commit_sha, 'The merged pull request has no merge revision.');
  requireThat(pr.head?.sha, 'The merged pull request has no head revision.');
}

function assertExternalPRRepository(pr, repository) {
  requireThat(pr.base?.repo?.full_name === repository, 'The other pull request belongs to a different repository.');
}

function assertExternalPRTarget(pr, target, repository) {
  requireThat(
    pr.base?.ref === target,
    `The pull request must be merged into ${repository}:${target}.`
  );
}

function assertCurrentTargetContainsPR(comparison) {
  requireThat(
    comparison.behind_by === 0 && ['ahead', 'identical'].includes(comparison.status),
    'The current target no longer contains the other pull request merge.'
  );
}

function assertExternalFiles(files) {
  requireThat(files?.length, 'GitHub returned no changed files for the pull request.');
}

function githubStatus(error) {
  return /HTTP (\d{3})/.exec(error.stderr || '')?.[1];
}

function githubFailure(error, session) {
  const status = githubStatus(error);
  if (status === '409')
    return repairableBlocker(
      'target-outdated',
      'GitHub rejected the merge because its candidate or target changed. Fetch and merge the current target, then verify the repaired candidate.'
    );
  if (!session) return error;
  return safeGitHubFailure(error, status);
}

function safeGitHubFailure(error, status) {
  const safe = Error('Factory GitHub App request failed' + (status ? ` (HTTP ${status})` : '') + '.');
  safe.githubStatus = Number(status) || null;
  safe.transient = infrastructureFailure(error);
  return safe;
}
