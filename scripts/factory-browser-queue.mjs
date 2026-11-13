export default async function queueBrowserChecks(page) {
  async function verifyNarrowQueue() {
    await page.setViewportSize({ width: 800, height: 800 });
    await page.getByLabel('Search issues', { exact: true }).waitFor();
    await page.locator('#issues tr').first().waitFor();
    await page.getByLabel('Search issues', { exact: true }).fill('Newer low');
    await page.waitForFunction(() => document.querySelectorAll('#issues tr').length === 1);
    if (!(await page.locator('#issues').innerText()).includes('Newer low'))
      throw Error('Search returned the wrong issue');
    await page.getByLabel('Search issues', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Create issue', exact: true }).click();
    await page.getByLabel('Description', { exact: true }).fill('Disposable unsaved draft');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    if (await page.locator('#create-issue-dialog').evaluate((dialog) => dialog.open))
      throw Error('Cancel did not close capture');
  }

  async function verifyIssueIdentity() {
    await page.goto(new URL('/#/issue/b', page.url()).href);
    await page.getByRole('heading', { name: 'Older urgent issue', exact: true }).waitFor();
    const identity = page.locator('p').filter({ hasText: 'Working branch:' });
    if (!(await identity.innerText()).includes('codex/example-work · 12345678'))
      throw Error('Issue working branch or short hash is missing');
    if ((await identity.locator('code').last().getAttribute('title')) !== '12345678' + 'a'.repeat(32))
      throw Error('Full commit hash is missing');
    if (
      !(await identity.evaluate((p) => {
        const row = p.closest('.issue-worktree-row') || p;
        return (
          row.previousElementSibling?.classList.contains('issue-title') &&
          row.previousElementSibling.querySelector('.issue-number')?.textContent === '#1'
        );
      }))
    )
      throw Error('Working branch must appear below the issue identity header');
    await page.screenshot({ path: 'issue-git.png', fullPage: false });
  }

  async function verifyWideIssueNavigation() {
    await page.setViewportSize({ width: 1280, height: 800 });
    if (await page.locator('.issue-sidebar').count()) throw Error('Issue-scoped data rendered the full queue sidebar.');
    const back = page.getByRole('link', { name: '← Issue queue', exact: true });
    await back.waitFor();
    await back.click();
    await page.getByText('Please select an issue.', { exact: true }).waitFor();
  }

  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: 'Issue queue', exact: true }).waitFor();
  await page.locator('.issue-sidebar .issue-sidebar-link').first().waitFor();
  await page.getByText('Please select an issue.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create issue', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh queue', exact: true }).waitFor();

  await verifyNarrowQueue();
  await verifyIssueIdentity();
  await verifyWideIssueNavigation();
  if (errors.length) throw Error(errors.join('; '));
  await page.screenshot({ path: 'queue.png', fullPage: false });
  return {
    passed: true,
    assertions: [
      'wide queue renders in the sidebar with an empty-selection prompt',
      'wide sidebar keeps issue creation available',
      'narrow queue renders and search filters',
      'capture opens',
      'cancel closes without saving',
      'no page errors',
      'issue branch and short hash under issue number',
      'full hash tooltip',
      'wide issue selection removes separate queue navigation',
    ],
  };
}
