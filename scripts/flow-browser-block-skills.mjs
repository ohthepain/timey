import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function blockSkillsBrowserChecks({ page, service, project, poll }) {
  const id = '20261119-block-skills-fixture';
  writeFileSync(
    join(project, '.issues', id + '.md'),
    `---\nid: ${id}\ntitle: Choose a block skill\nstate: backlog\n---\n\nFix a fixture.\n`
  );
  const skills = async () => [{ name: 'poteto-mode' }];
  service.projectDiscussOptions = { skills };
  if (service.projectDiscuss) service.projectDiscuss.options.skills = skills;
  const issue = service.flows.selected(id);
  const work = service.flows.read(issue).blocks.find((block) => block.kind === 'work');
  await page.goto('/?issue=' + id);
  const picker = page.locator(`[data-skill-picker="${work.id}"]`);
  await picker.waitFor();
  assert.match(await picker.textContent(), /poteto-mode/);
  await picker.click();
  const select = page.getByLabel('Block skill', { exact: true });
  await poll(
    () => select.locator('option[value="__setup_skills__"]').count(),
    (count) => count === 1,
    'Missing block skills should offer setup'
  );
  assert.equal(await select.locator('option[value="arena"]').evaluate((option) => option.disabled), true);
  assert.equal(await select.locator('option').last().textContent(), 'No skill');
  await select.selectOption('none');
  await poll(
    () => service.flows.read(issue).blocks.find((block) => block.id === work.id).skillExplicit,
    Boolean,
    'Choice was not saved'
  );
  assert.equal(service.flows.read(issue).blocks.find((block) => block.id === work.id).skill, null);
  await picker.click();
  await select.selectOption('poteto-mode');
  await poll(
    () => service.flows.read(issue).blocks.find((block) => block.id === work.id).skill,
    (value) => value === 'poteto-mode',
    'Selected block skill was not saved'
  );
  let opened = false;
  await page.route('**/api/flow-action', async (route) => {
    const input = route.request().postDataJSON();
    if (input.action !== 'open-block-extension') return route.continue();
    assert.equal(input.blockId, work.id);
    const path = service.flows.catalog.openExtension('work');
    assert.match(readFileSync(path, 'utf8'), /# Skill list/);
    opened = true;
    await route.fulfill({ json: service.flows.view(id) });
  });
  await picker.click();
  await select.selectOption('__add_skill__');
  await poll(() => opened, Boolean, 'Add skill did not open the block Markdown extension');
  await page.unroute('**/api/flow-action');
}
