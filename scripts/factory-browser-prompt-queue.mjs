import { assertControlText } from './browser-controls.mjs';

export default async function promptQueueChecks(page) {
  const calls = [];
  const queue = { paused: true, entries: [], operation: null, activeTurn: null, native: null };
  const skill = { name: 'grilling', description: 'Ask focused questions', source: 'Project' };
  await page.route('**/api/issue-chat?*', (route) => route.fulfill({ json: { issueId: 'b', messages: [], queue } }));
  await page.route('**/api/issue-chat-skills?*', (route) => route.fulfill({ json: { skills: [skill] } }));
  await page.route('**/api/issue-chat-send', async (route) => {
    const input = route.request().postDataJSON();
    calls.push(input);
    queue.entries.push({ ...input, revision: 1, status: 'waiting' });
    await route.fulfill({ json: { saved: true } });
  });
  await page.route('**/api/issue-chat-control', async (route) => {
    const input = route.request().postDataJSON();
    calls.push(input);
    updateQueue(input);
    await route.fulfill({ json: { saved: true } });
  });
  function updateQueue(input) {
    const entry = queue.entries.find((item) => item.id === input.id);
    const operations = {
      edit: () => Object.assign(entry, { text: input.text, skills: input.skills, revision: entry.revision + 1 }),
      remove: () => {
        queue.entries = queue.entries.filter((item) => item.id !== input.id);
      },
      resume: () => {
        queue.paused = false;
      },
      pause: () => {
        queue.paused = true;
      },
      stop: () => {
        queue.paused = true;
        queue.activeTurn = null;
      },
    };
    operations[input.operation]();
  }
  function expect(condition, message) {
    if (!condition) throw Error(message);
  }
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.locator('#issue-tab-issue').click();
  const composer = page.locator('.issue-conversation');
  const input = composer.locator('#issue-chat-input-b');
  await input.fill('/grilling');
  await composer.getByRole('option').filter({ hasText: 'grilling' }).click();
  await input.fill('First queued question');
  await composer.locator('.discussion-compose button[type="submit"]').click();
  await composer.locator('[data-prompt-id]').filter({ hasText: 'First queued question' }).waitFor();
  await input.fill('Second queued question');
  await composer.locator('.discussion-compose button[type="submit"]').click();
  await composer.locator('[data-prompt-id]').filter({ hasText: 'Second queued question' }).waitFor();
  const firstId = queue.entries[0].id;
  await page.reload();
  await page.locator('#issue-tab-issue').click();
  const first = composer.locator('[data-prompt-id]').filter({ hasText: 'First queued question' });
  await first.locator('[data-prompt-control="edit"]').click();
  expect(await composer.locator('[data-skill="grilling"]').isVisible(), 'Editing lost the selected skill');
  await input.fill('Edited first question');
  await composer.locator('.discussion-compose button[type="submit"]').click();
  await composer.locator('[data-prompt-id]').filter({ hasText: 'Edited first question' }).waitFor();
  expect(queue.entries[0].id === firstId, 'Editing changed FIFO position or identity');
  expect(queue.entries[0].skills[0] === 'grilling', 'Editing lost skill identity');
  await composer
    .locator('[data-prompt-id]')
    .filter({ hasText: 'Second queued question' })
    .locator('[data-prompt-control="remove"]')
    .click();
  await composer.locator('button[data-operation="resume"]').click();
  await composer.locator('button[data-operation="pause"]').waitFor();
  expect(queue.entries.length === 1, 'Removal lost or duplicated another prompt');
  queue.operation = { id: 'merge-1', kind: 'merge', cancellable: false };
  await page.reload();
  await page.locator('#issue-tab-issue').click();
  await composer.locator('button[data-operation="pause"]').waitFor();
  await composer.getByText('Factory is running merge. New prompts will wait.', { exact: true }).first().waitFor();
  await assertControlText(composer.locator('button[data-operation="pause"]'), 'Pause after this operation');
  expect(await composer.locator('[data-prompt-stop]').isHidden(), 'Merge incorrectly offered Stop');
  await input.fill('A question during merge');
  await composer.locator('.discussion-compose button[type="submit"]').click();
  await composer.locator('[data-prompt-id]').filter({ hasText: 'A question during merge' }).waitFor();
  expect(
    await composer.locator('[data-prompt-control="steer"]').first().isDisabled(),
    'Unconfirmed turn offered steering'
  );
  await page.screenshot({ path: 'issue-prompt-queue.png', fullPage: false });
  await page.unroute('**/api/issue-chat?*');
  await page.unroute('**/api/issue-chat-skills?*');
  await page.unroute('**/api/issue-chat-send');
  await page.unroute('**/api/issue-chat-control');
  return {
    passed: true,
    assertions: [
      'paused queue survives reload',
      'editing retains skills and FIFO identity',
      'remove targets only selected entry',
      'Resume releases pause',
      'merge offers pause-after and allows queueing',
      'unconfirmed steer disabled',
    ],
  };
}
