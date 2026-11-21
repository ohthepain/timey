import assert from 'node:assert/strict';

export async function projectNavigationBrowserChecks({ page, screenshot }) {
  await page.goto('/');
  const menu = page.getByRole('navigation', { name: 'Project menu' });
  assert.deepEqual(await menu.getByRole('button').allTextContents(), ['Home', 'Issues', 'Investigate']);
  await page.getByRole('tab', { name: 'Automate me', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Automate me', exact: true });
  await panel.waitFor({ state: 'visible' });
  await panel.getByRole('heading', { name: 'Automate me sessions' }).waitFor();
  await screenshot('project-navigation-automate');
  await panel.getByRole('button', { name: 'Run Automate me', exact: true }).click();
  const dialog = page.locator('#home-automate-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'Close Automate me' }).click();
  await page.reload();
  await panel.waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('tab', { name: 'Automate me' }).getAttribute('aria-selected'), 'true');
  const queueResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/queue');
  await menu.getByRole('button', { name: 'Issues', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Issues', exact: true }).waitFor({ state: 'visible' });
  const queue = await queueResponse;
  assert.equal(queue.status(), 200, await queue.text());
  await page.frameLocator('#project-issues iframe').getByRole('button', { name: 'Open', exact: true }).waitFor();
  await menu.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Home', exact: true }).waitFor({ state: 'visible' });
  await screenshot('project-navigation');
  await menu.getByRole('button', { name: 'Investigate', exact: true }).click();
  await page.locator('#home-investigation-dialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Close investigation', exact: true }).click();
  await page.setViewportSize({ width: 720, height: 960 });
  await page.getByRole('tab', { name: 'Automate me', exact: true }).click();
  await panel.waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 960 });
}
