import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectHome } from './factory-ui/project-home.mjs';
import { digest } from './factory-ui/common.mjs';

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
  assert.equal(await dialog.locator('select').count(), 3, 'Focus, branch, and follow-up destination; no folder scope.');
  await dialog.locator('#home-investigation-branch').selectOption('refs/heads/recent');
  await dialog.locator('#home-investigation-focus').selectOption('Architecture');
  await dialog.locator('#home-investigation-prompt').fill('Investigate validation across the project.');
  await dialog.locator('#home-investigation-instructions').fill('Prioritize clear boundaries.');
  await dialog.locator('summary').click();
  await dialog.locator('#home-investigation-message').fill('Which boundary should we examine?');
  await dialog.getByRole('button', { name: 'Send message', exact: true }).click();
  await dialog.locator('#home-investigation-messages').getByText(findings, { exact: true }).waitFor();
  assert.equal(service.projectHome.investigations.view()[0].status, 'draft');
  assert.equal(service.flows.issues().filter(({ title }) => title === proposal.title).length, 0);
  await screenshot('project-investigation-discussion');
  await dialog.getByRole('button', { name: 'Run investigation', exact: true }).click();
  await dialog.locator('#home-investigation-status').getByText('completed', { exact: true }).waitFor();
  const session = service.projectHome.investigations.view()[0];
  assert.equal(session.branch, 'refs/heads/recent');
  assert.equal(calls.investigations, 2);
  const child = service.flows.issues().find(({ source_issue }) => source_issue === session.issueId);
  assert.equal(child.state, 'needs-approval');
  assert.equal(child.source_attempt, session.attemptId);
  assert.match(
    service.flows.read(service.flows.selected(session.issueId)).blocks.find(({ kind }) => kind === 'understand').prompt,
    /Prioritize clear boundaries/
  );
  await screenshot('project-investigation-completed');
  await dialog.getByRole('button', { name: 'Close investigation', exact: true }).click();
  await page.reload();
  await page.locator('[data-home-session="investigation"]').first().waitFor();
  assert.equal(calls.investigations, 2, 'Reload starts no investigation.');
  await page.locator('[data-home-session="investigation"]').first().click();
  await dialog.locator('#home-investigation-issue').click();
  await page.locator('#issue-heading:not([hidden])').waitFor();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('#project-home:not([hidden])').waitFor();
}

async function automate(page, service, calls, screenshot) {
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
  const calls = { investigations: 0, automate: 0 };
  configureHome(service, calls);
  await page.goto('/');
  await page.locator('#home-title').getByText(service.root.split('/').at(-1), { exact: true }).waitFor();
  assert.equal(calls.investigations, 0);
  assert.equal(calls.automate, 0);
  await page.locator('#home-title').click();
  assert.equal(await page.locator('#home-investigation-dialog').isVisible(), false);
  await screenshot('project-home');
  await investigate(page, service, calls, screenshot);
  await automate(page, service, calls, screenshot);
}
