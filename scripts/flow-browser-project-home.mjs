import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectHome } from './factory-ui/project-home.mjs';
import { digest, git } from './factory-ui/common.mjs';

const draft = `---\nname: fixture-mode\ndescription: Work in the fixture user's style when explicitly selected.\ndisable-model-invocation: true\n---\n\nKeep responses concise. Verify changed behavior.\n`;
const findings =
  'Observed source.txt:1. The project needs input validation. Add a bounded validation boundary and prove invalid input is rejected.';
const proposal = {
  title: 'Validate project operation input',
  type: 'bug',
  description: 'Reject invalid project operation input.',
  reason: 'The investigation observed missing validation at source.txt:1.',
  verification: 'An invalid operation returns a useful error without writing source.',
};

function configureHome(service, calls) {
  const original = service.flows.executor.run.bind(service.flows.executor);
  service.flows.executor.run = async (ctx) => {
    if (!ctx.flow.projectInvestigation) return original(ctx);
    calls.investigations++;
    const path = join(service.root, '.issues/factory-ui/flow-evidence', ctx.attempt.id, 'response.txt');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, findings);
    const proof = { path, sha256: digest(findings), label: 'Block response' };
    return {
      output: findings,
      summary: 'Found one validation improvement.',
      evidence: [proof],
      artifacts: { values: {}, files: { response: proof } },
    };
  };
  service.projectHome?.close();
  service.projectHome = new ProjectHome(service, service.flows, {
    investigations: { propose: async () => [proposal] },
    automateMe: {
      history: async (_service, window) => ({
        messages: [{ role: 'user', text: 'Keep replies concise.', at: window.until }],
        coverage: {
          ...window,
          messageCount: 1,
          threadCount: 1,
          gaps: ['Synthetic browser history.'],
          truncated: false,
        },
      }),
      providerFactory: () => ({
        async turn(_session, input) {
          calls.automate++;
          calls.duration = input.context.duration;
          return calls.automate === 1
            ? { message: 'Which working habit matters most?', draft: null }
            : { message: 'Review this proposed skill.', draft: { name: 'fixture-mode', content: draft } };
        },
        close() {},
      }),
    },
  });
}

async function investigate(page, service, calls, screenshot) {
  await page.getByRole('button', { name: 'Start an investigation', exact: true }).click();
  const dialog = page.locator('#home-investigation-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('#home-investigation-branch').inputValue(), 'refs/heads/dev');
  await dialog.locator('#home-investigation-branch').selectOption('refs/heads/recent');
  await dialog.locator('#home-investigation-focus').selectOption('Architecture');
  await dialog.locator('#home-investigation-prompt').fill('Investigate validation across the project.');
  await dialog.locator('#home-investigation-instructions').fill('Prioritize clear boundaries.');
  await dialog.locator('#home-investigation-reusable').check();
  assert.equal(await dialog.getByRole('button', { name: 'Run investigation', exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Create investigation', exact: true }).click();
  const investigation = page.locator('#investigation-page');
  await investigation.waitFor({ state: 'visible' });
  await page.locator('#investigation-prompt').waitFor();
  assert.equal(calls.investigations, 0, 'Creation starts no model work.');
  assert.equal(await page.locator('#close-with-reason').isVisible(), false);
  assert.equal(await page.locator('#worktree-menu').isVisible(), false);
  await investigation.getByRole('button', { name: 'Run investigation', exact: true }).click();
  await page.locator('#investigation-status').getByText('Latest investigation completed.', { exact: true }).waitFor();
  assert.equal(calls.investigations, 1);
  const issueId = new URL(page.url()).searchParams.get('issue');
  const owner = service.projectHome.investigations;
  const first = owner.issueView(issueId);
  assert.equal(first.runs.length, 1);
  assert.equal(first.runs[0].issues[0].state, 'needs-approval');
  assert.equal(first.runs[0].revision, service.flows.read(service.flows.selected(issueId)).startingPoint.commit);
  await screenshot('investigation-first-result');
  await investigation.getByRole('button', { name: 'Run again', exact: true }).click();
  await page.locator('#investigation-status').getByText('Latest investigation completed.', { exact: true }).waitFor();
  await page.locator('#investigation-runs-label').getByText('Runs (2)', { exact: true }).waitFor();
  assert.equal(calls.investigations, 2);
  assert.equal(
    service.flows.issues().filter(({ source_issue }) => source_issue === issueId).length,
    1,
    'Repeats do not duplicate issues.'
  );
  await page.locator('#investigation-runs-label').click();
  await page.locator('[data-investigation-run]').last().click();
  await page.locator('#investigation-result-panel').getByText('Created this run', { exact: false }).waitFor();
  await screenshot('investigation-run-history');
  await page.reload();
  await investigation.waitFor({ state: 'visible' });
  await page.locator('#investigation-runs-label').getByText('Runs (2)', { exact: true }).waitFor();
  assert.equal(calls.investigations, 2, 'Reload starts no investigation.');
  await page.locator('#investigation-archive').click();
  await page.locator('#investigation-status').getByText('Archived', { exact: true }).waitFor();
  assert.equal(owner.issueView(issueId).runs.length, 2);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.locator('#investigation-status').getByText('Latest investigation completed.', { exact: true }).waitFor();
  assert.equal(owner.issueView(issueId).reusable, true);
  assert.equal(await page.locator('#issue-playback').isVisible(), false);
  await page.locator('#investigation-reusable').uncheck();
  await page.getByRole('button', { name: 'Save investigation settings', exact: true }).click();
  await page.locator('#issue-subtitle').getByText('One-time', { exact: true }).waitFor();
  assert.equal(await page.locator('#investigation-run').isDisabled(), true);
  assert.equal(await page.locator('#close-with-reason').isVisible(), false);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('#project-home:not([hidden])').waitFor();
}

async function automate(page, service, calls, screenshot) {
  await page.getByRole('tab', { name: 'Automate me', exact: true }).click();
  await page.getByRole('button', { name: 'Run Automate me', exact: true }).click();
  const dialog = page.locator('#home-automate-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('#home-automate-duration').inputValue(), '4');
  assert.equal(await dialog.locator('#home-automate-unit').inputValue(), 'weeks');
  await dialog.locator('#home-automate-duration').fill('10');
  await dialog.locator('#home-automate-unit').selectOption('days');
  await dialog.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await dialog.getByText('Which working habit matters most?', { exact: true }).waitFor();
  assert.equal(calls.duration.durationValue, 10);
  assert.equal(calls.duration.durationUnit, 'days');
  await dialog.locator('#home-automate-message').fill('Make verification explicit.');
  await dialog.getByRole('button', { name: 'Send reply', exact: true }).click();
  await dialog.locator('#home-automate-review:not([hidden])').waitFor();
  assert.match(await dialog.locator('#home-automate-path').textContent(), /\.agents\/skills\/fixture-mode\/SKILL.md$/);
  const apply = dialog.getByRole('button', { name: 'Apply reviewed skill', exact: true });
  await dialog.locator('#home-automate-content').fill(draft + '\nKeep evidence with the result.\n');
  assert.equal(await apply.isDisabled(), true);
  await dialog.getByRole('button', { name: 'Review destination and changes', exact: true }).click();
  await apply.waitFor({ state: 'visible' });
  await screenshot('project-automate-review');
  await apply.click();
  await dialog.locator('#home-automate-status').getByText('applied', { exact: true }).waitFor();
  assert.match(
    readFileSync(join(service.root, '.agents/skills/fixture-mode/SKILL.md'), 'utf8'),
    /Keep evidence with the result/
  );
  await dialog.getByRole('button', { name: 'Close Automate me', exact: true }).click();
  await page.reload();
  await page.locator('[data-home-session="automate"]').first().waitFor();
  assert.equal(calls.automate, 2, 'Reload starts no Automate me turn.');
  await page.setViewportSize({ width: 720, height: 960 });
  await screenshot('project-home-narrow');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 960 });
}

export async function projectHomeBrowserChecks({ page, service, screenshot }) {
  const labels = join(service.root, '.issues/triage-labels.md');
  if (!existsSync(labels)) copyFileSync(new URL('../.issues/triage-labels.md', import.meta.url), labels);
  const calls = { investigations: 0, automate: 0 };
  configureHome(service, calls);
  await page.goto('/');
  await page.locator('#home-title').getByText(service.root.split('/').at(-1), { exact: true }).waitFor();
  assert.equal(calls.investigations, 0);
  assert.equal(calls.automate, 0);
  await page.locator('#home-title').click();
  assert.equal(await page.locator('#home-investigation-dialog').isVisible(), false);
  await screenshot('project-home');
  await pruneWorktrees(page, service, screenshot);
  await cleanRemoteBranches(page, screenshot);
  await cleanLocalBranches(page, service, screenshot);
  await deleteArchivedReports(page, service, screenshot);
  await investigate(page, service, calls, screenshot);
  await automate(page, service, calls, screenshot);
}

async function deleteArchivedReports(page, { root }, screenshot) {
  const id = '20261118-archive-fixture';
  const title = 'Disposable archived issue';
  const branch = `codex/issue-${id}`;
  const archive = join(root, '.issues/archive');
  mkdirSync(archive, { recursive: true });
  const report = join(archive, id + '.md');
  writeFileSync(report, `---\nid: ${id}\ntitle: ${title}\nstate: closed\n---\nDisposable archive record.\n`);
  git(root, 'branch', branch, 'dev');
  await page.getByRole('tab', { name: 'Admin' }).click();
  await page.getByRole('button', { name: 'Preview archived issues' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete archived issues' });
  const choice = dialog.getByRole('checkbox', { name: title, exact: true });
  await choice.check();
  const branchChoice = dialog.getByRole('checkbox', { name: `Also delete local branch ${branch}` });
  assert.equal(await branchChoice.isChecked(), false);
  await branchChoice.check();
  await dialog.getByRole('button', { name: 'Review deletion' }).click();
  await dialog.getByRole('heading', { name: 'Confirm archive deletion' }).waitFor();
  assert.match(readFileSync(report, 'utf8'), /Disposable archive record/);
  assert.equal(git(root, 'branch', '--format=%(refname:short)', '--list', branch), branch);
  await screenshot('project-admin-archive-deletion-confirmation');
  await dialog.getByRole('button', { name: 'Permanently delete 1 archived issue' }).click();
  await dialog.getByText(`${branch} · deleted`).waitFor();
  assert.equal(git(root, 'branch', '--list', branch), '');
  assert.throws(() => readFileSync(report), /ENOENT/);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Home' }).click();
}

async function cleanRemoteBranches(page, screenshot) {
  const endpoint = '**/api/project-remote-branch-cleanup';
  const requests = [];
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: {
          id: 'reviewed-preview',
          repository: 'fixture/timey',
          target: 'dev',
          readOnly: false,
          entries: [
            { name: 'merged-one' },
            { name: 'merged-two' },
            { name: 'still-open', reason: 'Used by an open pull request.' },
          ],
        },
      });
    }
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        results: [
          { name: 'merged-one', status: 'deleted' },
          { name: 'merged-two', status: 'deleted' },
        ],
      },
    });
  });
  await page.getByRole('tab', { name: 'Admin' }).click();
  await page.getByRole('button', { name: 'Preview remote branches' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clean up remote branches' });
  await dialog.getByText('fixture/timey · merged into dev · 2 eligible').waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Review deletion' }).isDisabled(), true);
  await dialog.getByText('Branches kept (1)').click();
  await dialog.getByText('still-open · Used by an open pull request.').waitFor();
  await dialog.getByRole('checkbox', { name: 'Select all eligible branches' }).check();
  await dialog.getByRole('button', { name: 'Review deletion' }).click();
  await dialog.getByRole('heading', { name: 'Confirm branch deletion' }).waitFor();
  assert.deepEqual(requests, []);
  await screenshot('project-admin-remote-branch-confirmation');
  await dialog.getByRole('button', { name: 'Delete 2 remote branches' }).click();
  await dialog.getByText('merged-two · deleted').waitFor();
  assert.deepEqual(requests, [{ id: 'reviewed-preview', selected: ['merged-one', 'merged-two'] }]);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Home' }).click();
  await page.unroute(endpoint);
}

async function cleanLocalBranches(page, service, screenshot) {
  const { root } = service;
  const { repository } = JSON.parse(readFileSync(join(root, '.issues/issue-delivery-config.json'), 'utf8'));
  service.localBranchCleanupOptions = {
    provider: () => ({
      gh: async (args) =>
        args.includes(`repos/${repository}`)
          ? JSON.stringify({ full_name: repository, node_id: 'fixture', default_branch: 'dev' })
          : JSON.stringify([[]]),
    }),
  };
  const branch = 'admin-unused-local';
  git(root, 'branch', branch, 'dev');
  await page.getByRole('tab', { name: 'Admin' }).click();
  await page.getByRole('button', { name: 'Preview local branches' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clean up local branches' });
  await dialog.getByRole('checkbox', { name: branch, exact: true }).check();
  await dialog.getByRole('button', { name: 'Review deletion' }).click();
  await dialog.getByRole('heading', { name: 'Confirm branch deletion' }).waitFor();
  assert.equal(git(root, 'branch', '--format=%(refname:short)', '--list', branch), branch);
  await screenshot('project-admin-local-branch-confirmation');
  await dialog.getByRole('button', { name: 'Delete 1 local branch' }).click();
  await dialog.getByText(`${branch} · deleted`).waitFor();
  assert.equal(git(root, 'branch', '--list', branch), '');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Home' }).click();
}

async function pruneWorktrees(page, { root }, screenshot) {
  const checkout = join(root, 'missing checkout');
  const branch = 'admin-worktree-fixture';
  git(root, 'worktree', 'add', '-b', branch, checkout, 'dev');
  rmSync(checkout, { recursive: true });
  await page.getByRole('tab', { name: 'Admin' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Prune worktrees' }).click();
  const dialog = page.getByRole('dialog', { name: 'Prune worktrees' });
  const branchChoice = dialog.getByRole('checkbox', { name: `Delete local branch ${branch}`, exact: true });
  await dialog.getByLabel('Comparison branch').selectOption('refs/heads/dev');
  await branchChoice.waitFor();
  assert.equal(await branchChoice.isChecked(), true);
  assert.match(git(root, 'worktree', 'list', '--porcelain'), /missing checkout/);
  await screenshot('project-admin-worktree-preview');
  await dialog.getByRole('button', { name: 'Remove 1 worktree record and 1 branch' }).click();
  await dialog.getByText(`Worktree record removed. Deleted ${branch}.`).waitFor();
  assert.equal(git(root, 'branch', '--list', branch), '');
  assert.doesNotMatch(git(root, 'worktree', 'list', '--porcelain'), /missing checkout/);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Home' }).click();
}
