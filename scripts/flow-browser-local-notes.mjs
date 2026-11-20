import assert from 'node:assert/strict';
import { LocalNotes } from './factory-ui/local-notes.mjs';

export async function localNotesBrowserChecks({ page, service, project, poll, screenshot }) {
  const turns = [];
  service.projectDiscussOptions = {
    modelSettings: () => ({
      defaults: { model: 'test', effort: 'high' },
      models: [{ id: 'test', name: 'Test' }],
      efforts: ['high'],
    }),
    skills: async () => [],
    createProvider: () => ({
      async turn(_session, message) {
        turns.push(message);
        return { text: 'Let’s discuss this note.' };
      },
      close() {},
    }),
  };
  const notes = new LocalNotes(project);
  await page.goto('/');
  const field = page.locator('#local-note-text');
  await field.fill('Remember the quick thought');
  await field.press('Enter');
  await page.getByRole('button', { name: 'Remember the quick thought', exact: true }).waitFor();
  assert.equal(await field.inputValue(), '');
  const disclosure = page.locator('#local-notes-toggle');
  const otherDisclosure = page.locator('.sidebar-files .folder-disclosure').first();
  await otherDisclosure.waitFor();
  const caretStyle = (button) => {
    const style = getComputedStyle(button, '::before');
    return { clipPath: style.clipPath, width: style.width, height: style.height, background: style.backgroundColor };
  };
  assert.deepEqual(await disclosure.evaluate(caretStyle), await otherDisclosure.evaluate(caretStyle));
  const expandedTransform = await disclosure.evaluate((button) => getComputedStyle(button, '::before').transform);
  await field.fill('Unfinished local note');
  await disclosure.click();
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await disclosure.getAttribute('aria-label'), 'Expand Local notes');
  assert.equal(await field.isVisible(), false);
  assert.equal(await page.locator('#local-note-list').isVisible(), false);
  const collapsedTransform = await disclosure.evaluate((button) => getComputedStyle(button, '::before').transform);
  assert.notEqual(collapsedTransform, expandedTransform);
  await screenshot('local-notes-collapsed');
  await disclosure.click();
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(await field.isVisible(), true);
  assert.equal(await field.inputValue(), 'Unfinished local note');
  await page.getByRole('button', { name: 'Remember the quick thought', exact: true }).waitFor();
  assert.equal(
    await disclosure.evaluate((button) => getComputedStyle(button, '::before').transform),
    expandedTransform
  );
  await screenshot('local-notes-expanded');
  await field.fill('');
  await page.reload();
  await page.getByRole('button', { name: 'Remember the quick thought', exact: true }).waitFor();
  await page.keyboard.press('Alt+n');
  await page.locator('#local-note-editor[open]').waitFor();
  await page.getByRole('textbox', { name: 'Note text', exact: true }).fill('Second thought');
  await page.locator('#local-note-edit-form').getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByRole('button', { name: 'Second thought', exact: true }).waitFor();
  const second = notes.view().notes.find((note) => note.text === 'Second thought');
  const row = page.locator(`[data-note-id="${second.id}"]`);
  await row.locator('summary').click();
  await row.getByRole('button', { name: 'Move note down', exact: true }).click();
  await poll(
    () => notes.view().notes[1]?.id,
    (value) => value === second.id,
    'Manual note order'
  );
  await row.getByRole('checkbox').check();
  await poll(() => notes.get(second.id).done, Boolean, 'Note completion');
  await row.getByRole('button', { name: 'Second thought', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note text', exact: true }).fill('Edited second thought');
  await page.locator('#local-note-edit-form').getByRole('button', { name: 'Save note', exact: true }).click();
  await row.getByRole('button', { name: 'Edited second thought', exact: true }).waitFor();
  await screenshot('local-notes-sidebar');
  await row.getByRole('button', { name: 'Discuss', exact: true }).click();
  await page.locator('#discuss-draft').waitFor();
  await poll(
    () => page.locator('#discuss-draft').inputValue(),
    (value) => value.includes('think through'),
    'Suggested first prompt'
  );
  assert.equal(turns.length, 0);
  assert.match(await page.locator('#discuss-messages').innerText(), /Edited second thought/);
  const draft = page.locator('#discuss-draft');
  await draft.fill('My own question about this note');
  await page.locator('#discuss-send').click();
  await poll(
    () => turns.length,
    (value) => value === 1,
    'Only explicit Send starts a reply'
  );
  await page.getByText('Let’s discuss this note.', { exact: true }).waitFor();
  const noteRow = page.locator(`[data-note-id="${second.id}"]`);
  await noteRow.locator('summary').click();
  await noteRow.getByRole('button', { name: 'Turn into issue', exact: true }).click();
  await page.locator('#capture-dialog[open]').waitFor();
  assert.equal(await page.locator('#capture-description').inputValue(), 'Edited second thought');
  await page.locator('#capture-description').fill('An issue from the quick note');
  await page.locator('#capture-form button[type="submit"]').click();
  await page.getByRole('button', { name: 'Delete original note', exact: true }).waitFor();
  const link = page.locator('#discuss-messages').getByRole('link', { name: 'the new issue', exact: true });
  assert.match(await link.getAttribute('href'), /\?issue=/);
  assert.ok(notes.get(second.id).issueId);
  assert.equal(turns.length, 1);
  await screenshot('local-note-created-issue');
  await page.getByRole('button', { name: 'Delete original note', exact: true }).click();
  await poll(
    () => notes.view().notes.length,
    (value) => value === 1,
    'Explicit original note deletion'
  );
  await page.getByText('Original note deleted.', { exact: true }).waitFor();
  assert.equal(turns.length, 1);
  await field.fill('Draft survives reload');
  await page.reload();
  assert.equal(await field.inputValue(), 'Draft survives reload');
  return [
    'Inline and shortcut capture persist across reloads',
    'Edit, completion and order are retained',
    'Discuss prepares quietly and only Send starts a reply',
    'Issue creation is prefilled and links back before optional deletion',
    'Unsaved capture draft survives reload',
  ];
}
