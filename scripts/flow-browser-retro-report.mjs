import assert from 'node:assert/strict';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './factory-ui/common.mjs';
import { createFlowExecutor } from './factory-ui/flow-executor.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { installBrowserHumanInput, writeBrowserIssue } from './flow-browser-fixture.mjs';
import { withBrowserScenarioFixture } from './flow-browser-scenario-fixture.mjs';

const cases = [
  {
    name: 'with-followups',
    title: 'Review a release with repeated retries',
    summary:
      'The release had to be retried twice. Its status was unclear.\n\n- Reviewers waited for an update they could trust.',
    followups: [
      ['investigation', 'Investigation', 'Trace when the status first diverges'],
      ['bug', 'Bug fix', 'Refresh the stale release status'],
      ['feature', 'Improvement', 'Show which release attempt is current'],
    ],
  },
  {
    name: 'without-followups',
    title: 'Review a release completed as planned',
    summary: 'The release completed on the first attempt. Its status matched the verified outcome.',
    followups: [],
  },
];

export async function retroReportBrowserChecks({ page, project, service, output, root, poll }) {
  return withBrowserScenarioFixture({ project, service }, async () => {
    initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
    installBrowserHumanInput(project, root);
    const flows = service.flows;
    const outcomes = new Map();
    flows.executor = createFlowExecutor(service, { runRetro: (_service, { issue }) => outcomes.get(issue.id) });
    const observations = [];
    for (const scenario of cases) {
      const { name, title, summary, followups } = scenario;
      const id = '20261127-retro-' + name;
      outcomes.set(id, {
        summary,
        recommendations: followups.map(([type, , title]) => ({
          type,
          title,
          description: 'Capture the actionable finding from the release review.',
          reason: 'Give reviewers accurate status.',
          verification: 'Observe that the saved status identifies the current release attempt.',
          requestId: randomUUID(),
        })),
      });
      const request = 'Keep the original release request in the report.';
      await writeBrowserIssue(service, { id, title, body: request });
      const checkout = await addCheckout(flows, project, id);
      await closeWithRetro(page, id);
      await poll(
        () => flows.read(flows.selected(id)).closing?.complete,
        Boolean,
        'Retro and Cleanup did not finish. ' + id
      );
      assert.equal(existsSync(checkout), false, 'Cleanup removed the actual fixture worktree.');
      assert.equal(flows.selected(id).location, 'closed');
      const screenshot = 'retro-report-' + name + '.png';
      const report = await openReport(page, id);
      await report.getByText(request, { exact: true }).waitFor();
      await report.getByText(summary.split('\n\n')[0], { exact: true }).waitFor();
      await report.getByRole('heading', { name: 'Retro', exact: true }).scrollIntoViewIfNeeded();
      if (!followups.length) await report.getByText('No follow-up issues were created.', { exact: true }).waitFor();
      const renderedSummary = await report.locator('article').innerText();
      await report.screenshot({ path: join(output, screenshot) });
      const linkedIssues = await verifyLinks(page, flows, id, followups, report);
      observations.push({ id, title, checkoutRemoved: true, screenshot, renderedSummary, linkedIssues });
    }
    writeFileSync(
      join(output, 'retro-report.json'),
      JSON.stringify(
        {
          sourceCommit: git(root, 'rev-parse', 'HEAD'),
          fixture: 'Only the Retro provider reply is simulated. Factory closes the local fixture and runs Cleanup.',
          observations,
        },
        null,
        2
      ) + '\n'
    );
  });
}

async function addCheckout(flows, project, id) {
  const flow = flows.read(flows.selected(id));
  const base = git(project, 'rev-parse', 'refs/heads/dev');
  const checkout = join(realpathSync(project), '.issues/issue-work', id);
  const branch = 'codex/issue-' + id;
  git(project, 'worktree', 'add', '-qb', branch, checkout, base);
  flow.workspace = { branch, base, checkout };
  await flows.store.save(flow, flow.revision);
  return checkout;
}

async function closeWithRetro(page, id) {
  await page.goto('/?issue=' + id);
  await page.locator('#close-with-reason').click();
  const dialog = page.locator('#issue-closure-dialog');
  await dialog.getByRole('combobox', { name: 'Reason' }).selectOption('obsolete');
  await dialog.getByRole('checkbox', { name: 'Run Retro before Cleanup' }).check();
  await page.locator('#confirm-issue-closure').click();
  await dialog.waitFor({ state: 'hidden' });
}

async function openReport(page, id) {
  await page.goto('/?issue=' + id);
  await page.getByRole('button', { name: 'Issue report', exact: true }).click();
  const report = page.getByRole('dialog', { name: 'Issue report' });
  await report.getByRole('heading', { name: 'Retro', exact: true }).waitFor();
  return report;
}

async function verifyLinks(page, flows, id, followups, report) {
  const issues = flows.issues().filter(({ source_issue }) => source_issue === id);
  assert.equal(issues.length, followups.length);
  const linkedIssues = [];
  for (const [type, label, title] of followups) {
    const issue = issues.find((entry) => entry.title === title);
    assert.equal(issue?.request_type, type);
    assert.equal(issue.state, 'needs-approval');
    assert.ok(flows.read(issue).blocks.every(({ attempts }) => attempts.length === 0));
    const link = report.getByRole('link', { name: title, exact: true });
    await link.locator('..').getByText(label, { exact: true }).waitFor();
    const href = await link.getAttribute('href');
    assert.equal(href, '/?issue=' + issue.id);
    await link.click();
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('issue'), issue.id);
    linkedIssues.push({ title, label, href, state: issue.state });
    await openReport(page, id);
  }
  return linkedIssues;
}
