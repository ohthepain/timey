export default async function modelSettingsBrowserChecks(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: 'Issue queue', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open model and effort settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Default model and effort' });
  await dialog.waitFor();
  if ((await dialog.locator('select').count()) !== 2)
    throw Error('Default settings must contain only model and effort controls.');
  const defaultModel = dialog.getByLabel('Default model');
  const defaultEffort = dialog.getByLabel('Default effort');
  if ((await defaultModel.inputValue()) !== 'gpt-6-luna' || (await defaultEffort.inputValue()) !== 'medium')
    throw Error('The default model or effort is incorrect.');
  await defaultModel.selectOption('gpt-6.1-terra');
  if (!(await dialog.innerText()).includes('Fast visual reasoning, precise computer use, and clear writing.'))
    throw Error('The selected model description is missing.');
  await defaultEffort.selectOption('high');
  await dialog.getByRole('button', { name: 'Save defaults' }).click();
  await dialog.waitFor({ state: 'hidden' });

  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.getByRole('heading', { name: 'Older urgent issue', exact: true }).waitFor();
  const model = page.getByLabel('Model for new work on this issue');
  const effort = page.getByLabel('Effort for new work on this issue');
  if ((await model.inputValue()) !== '' || (await effort.inputValue()) !== '')
    throw Error('An issue without explicit choices should inherit the defaults.');
  if (!(await page.locator('[data-issue-model-settings]').innerText()).includes('work started after you save them'))
    throw Error('Issue settings do not explain when changes apply.');
  await model.selectOption('gpt-6-astra');
  await page.waitForFunction(async () => {
    const queue = await (await fetch('/api/queue')).json();
    return queue.issues.find((issue) => issue.id === 'b')?.modelSelection?.model === 'gpt-6-astra';
  });
  await effort.selectOption('low');
  await page.waitForFunction(async () => {
    const queue = await (await fetch('/api/queue')).json();
    return queue.issues.find((issue) => issue.id === 'b')?.modelSelection?.effort === 'low';
  });
  await page.screenshot({ path: 'issue-model-settings.png', fullPage: false });

  await page.goto(new URL('/#/issue/a', page.url()).href);
  await page.getByRole('heading', { name: 'Newer low issue', exact: true }).waitFor();
  if ((await page.getByLabel('Model for new work on this issue').inputValue()) !== '')
    throw Error('A global change became an explicit per-issue model choice.');
  const options = await page.evaluate(async () => (await (await fetch('/api/queue')).json()).modelSettings.defaults);
  if (options.model !== 'gpt-6.1-terra' || options.effort !== 'high') throw Error('Saved defaults did not persist.');
  if (errors.length) throw Error(errors.join('; '));
  return {
    passed: true,
    assertions: [
      'gear opens settings with only default model and effort controls',
      'GPT-6 Luna and medium are defaults',
      'model description follows the selected model',
      'issues inherit defaults until they have explicit choices',
      'issue model and effort choices save independently',
      'changes are described as applying to new work',
      'no page errors',
    ],
  };
}
