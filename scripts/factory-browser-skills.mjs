export default async function skillsBrowserChecks(page) {
  const errors = [],
    issueTurns = [],
    discussionTurns = [],
    skill = { name: 'practice', description: 'Practice timing patterns', source: 'Personal', icon: '✦' };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/issue-chat-skills*', (route) => route.fulfill({ json: { skills: [skill] } }));
  await page.route('**/api/issue-chat-send', async (route) => {
    issueTurns.push(route.request().postDataJSON());
    await route.fulfill({ json: { disposition: 'Saved.' } });
  });
  await page.route('**/api/discussion-open', (route) => route.fulfill({ json: { session: 'temporary-skills' } }));
  await page.route('**/api/discussion-skills', (route) => route.fulfill({ json: { skills: [skill] } }));
  await page.route('**/api/discussion-turn', async (route) => {
    discussionTurns.push(route.request().postDataJSON());
    await route.fulfill({ json: { text: 'Skill turn received.' } });
  });
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.getByRole('heading', { name: 'Older urgent issue', exact: true }).waitFor();

  await page.locator('[data-chat-tab="issue"]').click();
  let composer = page.locator('.issue-conversation textarea[aria-label="Chat input"]');
  await composer.fill('/practice');
  let option = page.getByRole('option').filter({ hasText: 'practice' });
  await option.waitFor();
  for (const text of ['Practice timing patterns', 'Personal'])
    if (!(await option.innerText()).includes(text)) throw Error(`Skill option is missing ${text}.`);
  await option.click();
  if (!(await page.locator('.issue-conversation .skill-chip').isVisible()))
    throw Error('The selected issue-chat skill is not visible as a colored token.');
  await composer.fill('Use this for my question.');
  await page.locator('.issue-conversation').getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => document.querySelector('[data-chat-panel="issue"] textarea')?.value === '');
  if (
    issueTurns.length !== 1 ||
    issueTurns[0].text !== 'Use this for my question.' ||
    issueTurns[0].skills?.[0] !== 'practice'
  )
    throw Error('The issue chat did not submit its selected skill with the message.');

  await page.getByRole('button', { name: 'Review decisions', exact: true }).click();
  composer = page.locator('#discussion-body textarea[aria-label="Chat input"]');
  await composer.fill('/practice');
  option = page.getByRole('option').filter({ hasText: 'practice' });
  await option.waitFor();
  await option.click();
  if (!(await page.locator('#discussion-body .skill-chip').isVisible()))
    throw Error('The selected discussion skill is not visible as a colored token.');
  await page.getByRole('button', { name: 'Send message' }).last().click();
  await page.waitForFunction(() =>
    document.querySelector('#discussion-body .discussion-output')?.textContent.includes('Skill turn received.')
  );
  if (discussionTurns.length !== 1 || discussionTurns[0].text !== '' || discussionTurns[0].skills?.[0] !== 'practice')
    throw Error('The discussion did not send a selected skill without accompanying text.');
  if (errors.length) throw Error(errors.join('; '));
  return {
    passed: true,
    assertions: [
      'issue chat filters and displays skill metadata',
      'issue chat submits selected skills',
      'discussion chat renders removable skill tokens',
      'discussion chat sends token-only skill turns',
      'no page errors',
    ],
  };
}
