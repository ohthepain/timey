import { runGitHubCli } from './github-cli.mjs';
import { cleanEnvironment, requireThat } from './common.mjs';
import { githubAppCredentials } from './github-app.mjs';
import { assertChecks, inspectReadiness, inspectRequiredPRChecks, latestChecks } from './strategy-readiness.mjs';
import { repairableBlocker } from './strategy-repair.mjs';
import { findIssueBranchPR, findStrategyPR, publishStrategyPR } from './strategy-publication.mjs';
import { safeGitHubFailure } from './github-request-failure.mjs';

export class StrategyProvider {
  constructor(root, config, credentialRoot = root) {
    this.root = root;
    this.reviewRoot = credentialRoot;
    this.config = config;
    this.credentials = githubAppCredentials(credentialRoot, config.repository);
  }
  async gh(args) {
    const env = cleanEnvironment();
    const session = this.credentials ? await this.credentials.session() : null;
    if (session) {
      env.GH_TOKEN = session.token;
      env.GH_HOST = 'github.com';
      delete env.GITHUB_TOKEN;
    }
    try {
      const stdout = await runGitHubCli(
        args,
        {
          cwd: this.root,
          env,
          encoding: 'utf8',
          timeout: args[0] === 'run' && args[1] === 'download' ? 120000 : 30000,
          maxBuffer: 8 * 1024 * 1024,
        },
        this.config.repository
      );
      return stdout.trim();
    } catch (error) {
      throw githubFailure(error, session);
    }
  }

  async inspect(number) {
    requireThat(Number.isSafeInteger(number) && number > 0, 'Return the actual issue PR number.');
    return JSON.parse(await this.gh(['api', `repos/${this.config.repository}/pulls/${number}`]));
  }
  async inspectExternalDelivery(number, { requiredChecksOnly = false } = {}) {
    requireThat(Number.isSafeInteger(number) && number > 0, 'Enter the pull request number to verify.');
    const pr = await this.inspect(number);
    assertExternalPRState(pr);
    assertExternalPRRepository(pr, this.config.repository);
    assertExternalPRTarget(pr, this.config.target, this.config.repository);
    const { targetRevision, checks, files } = await externalDeliveryEvidence(this, number, pr, requiredChecksOnly);
    assertExternalFiles(files);
    return {
      number,
      url: pr.html_url,
      target: pr.base.ref,
      targetRevision,
      branch: pr.head.ref,
      head: pr.head.sha,
      mergedAt: pr.merged_at,
      mergeCommit: pr.merge_commit_sha,
      checks,
      files: files.map((file) => file.path),
    };
  }
  async publish(work, head, publication) {
    return publishStrategyPR(this, work, head, publication);
  }
  async findByBranch(branch, target) {
    return findStrategyPR(this, branch, target);
  }
  async findIssueBranchPR(branch) {
    return findIssueBranchPR(this, branch);
  }
  async ready(pr, branch, head, { handoff = false, waitForChecks = false } = {}) {
    const reviewBypass = handoff ? () => this.canBypassOwnReview(pr) : undefined;
    return inspectReadiness(this, pr, branch, head, reviewBypass, waitForChecks);
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
    await this.assertHandoffBypassProtection();
    // Classic protection may coexist with rulesets.
    if ((await classicTargetProtection(this))?.required_pull_request_reviews) return false;
    const reviewRules = (await activeTargetRules(this)).filter((rule) => rule.type === 'pull_request');
    if (!reviewRules.length) return false;
    for (const id of new Set(reviewRules.map((rule) => rule.ruleset_id))) {
      if (!Number.isSafeInteger(id) || id <= 0) return false;
      const ruleset = await readRuleset(this, id);
      if (
        ruleset.id !== id ||
        ruleset.enforcement !== 'active' ||
        !['always', 'pull_requests_only'].includes(ruleset.current_user_can_bypass)
      )
        return false;
    }
    return true;
  }
  async assertHandoffBypassProtection() {
    const rulesets = await targetRulesets(this, await activeTargetRules(this));
    const active = rulesets.filter((ruleset) => ruleset.enforcement === 'active');
    const ciRulesets = active.filter((ruleset) =>
      (ruleset.rules || []).some((rule) => rule.type === 'required_status_checks')
    );
    requireThat(
      ciRulesets.flatMap((ruleset) => ruleset.rules).some(strictStatusRule),
      'Full Stop review bypass needs an active ruleset with strict required checks on the target branch. No merge was attempted.'
    );
    requireThat(
      ciRulesets.every((ruleset) => ruleset.current_user_can_bypass === 'never'),
      'Full Stop review bypass requires CI rulesets to prevent this credential from bypassing required checks, including administrators. No merge was attempted.'
    );
    return true;
  }
  targetFreshnessProtection() {
    return assertTargetFreshnessProtection(this);
  }
  async merge(number, head, { beforeMerge, requireFreshTarget = false } = {}) {
    const repository = JSON.parse(await this.gh(['api', 'repos/' + this.config.repository]));
    requireThat(
      repository.allow_merge_commit === true,
      'Enable merge commits in the GitHub repository settings before using Full Send.'
    );
    if (requireFreshTarget) await this.targetFreshnessProtection();
    // The REST merge compares the head SHA. Strict checks protect the target
    // even if it advances after this final observation.
    await beforeMerge?.();
    const merged = JSON.parse(
      await this.gh([
        'api',
        `repos/${this.config.repository}/pulls/${number}/merge`,
        '--method',
        'PUT',
        '-f',
        'sha=' + head,
        '-f',
        'merge_method=merge',
      ])
    );
    requireThat(merged.merged === true, 'The merge was not confirmed. Inspect the existing PR before retrying.');
    const pr = await this.inspect(number);
    requireConfirmedMerge(pr, head, merged.sha);
    return { url: pr.html_url, revision: pr.merge_commit_sha };
  }
}

function requireConfirmedMerge(pr, head, revision) {
  requireThat(
    pr.merged_at && pr.head.sha === head && pr.merge_commit_sha === revision,
    'Merge outcome is uncertain. Inspect the existing PR before any retry.'
  );
}

async function activeTargetRules(provider) {
  const { repository, target } = provider.config;
  const pages = JSON.parse(
    await provider.gh([
      'api',
      `repos/${repository}/rules/branches/${encodeURIComponent(target)}?per_page=100`,
      '--paginate',
      '--slurp',
    ])
  );
  return pages.flat();
}

async function readRuleset(provider, id) {
  return JSON.parse(await provider.gh(['api', `repos/${provider.config.repository}/rulesets/${id}`]));
}

async function targetRulesets(provider, rules) {
  const ids = [...new Set(rules.map((rule) => rule.ruleset_id).filter((id) => Number.isSafeInteger(id)))];
  return Promise.all(ids.map((id) => readRuleset(provider, id)));
}

function strictStatusRule({ type, parameters = {} }) {
  const { strict_required_status_checks_policy: strict, required_status_checks: checks = [] } = parameters;
  return type === 'required_status_checks' && strict === true && checks.length > 0;
}

async function classicTargetProtection(provider) {
  const { repository, target } = provider.config;
  try {
    return JSON.parse(
      await provider.gh(['api', `repos/${repository}/branches/${encodeURIComponent(target)}/protection`])
    );
  } catch (error) {
    if (error.githubStatus !== 404 && !/HTTP 404/.test(error.message)) throw error;
    return {};
  }
}

function classicStrictChecks({ enforce_admins: admins = {}, required_status_checks: statuses = {} }) {
  const { strict, checks = [], contexts = [] } = statuses;
  return admins.enabled === true && strict === true && checks.length + contexts.length > 0;
}

async function assertTargetFreshnessProtection(provider) {
  const target = provider.config.target;
  try {
    const rules = (await activeTargetRules(provider)).filter(strictStatusRule);
    const rulesets = await targetRulesets(provider, rules);
    const active = rulesets.filter((rule) => rule.enforcement === 'active' && rule.current_user_can_bypass === 'never');
    if (active.length)
      return { rules: rules.filter((rule) => active.some(({ id }) => id === rule.ruleset_id)), rulesets: active };
    const classic = await classicTargetProtection(provider);
    if (classicStrictChecks(classic)) return { classic };
  } catch (error) {
    error.message = `Could not confirm GitHub's up-to-date branch protection for ${target}. ${error.message}`;
    throw error;
  }
  throw Object.assign(
    Error(
      `Full Send requires GitHub to enforce up-to-date branches for ${target} without bypass for the merge credential. Configure strict required checks on the target branch.`
    ),
    { code: 'target-protection' }
  );
}

async function externalDeliveryEvidence(provider, number, pr, requiredChecksOnly) {
  if (requiredChecksOnly) {
    const ready = await inspectRequiredPRChecks(provider, number, pr.head.sha);
    await compareExternalTarget(provider, pr.merge_commit_sha, ready.targetRevision);
    const { files } = await externalPRFields(provider, number, 'files');
    return { ...ready, files };
  }
  const comparison = await compareExternalTarget(provider, pr.merge_commit_sha, provider.config.target);
  const { statusCheckRollup, files } = await externalPRFields(provider, number, 'statusCheckRollup,files');
  const checks = latestChecks(statusCheckRollup ?? []);
  assertChecks(checks);
  return { targetRevision: comparison.head_sha, checks, files };
}

async function compareExternalTarget(provider, merged, target) {
  const comparison = JSON.parse(
    await provider.gh([
      'api',
      `repos/${provider.config.repository}/compare/${encodeURIComponent(merged)}...${encodeURIComponent(target)}`,
    ])
  );
  assertCurrentTargetContainsPR(comparison);
  return comparison;
}

async function externalPRFields(provider, number, fields) {
  return JSON.parse(
    await provider.gh(['pr', 'view', String(number), '--repo', provider.config.repository, '--json', fields])
  );
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
  requireThat(pr.base?.ref === target, `The pull request must be merged into ${repository}:${target}.`);
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
  return safeGitHubFailure(error, status, session);
}
