import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalNotes } from './factory-ui/local-notes.mjs';
import { resolveIssueStorage } from './factory-ui/stores/settings.mjs';
import { ensureIssueNumbers } from './factory-ui/issue-numbers.mjs';

export async function localNotesBrowserChecks({ page, service, project, poll, screenshot, output, candidate }) {
  if (await page.locator('#discuss-draft').isVisible())
    await page.locator('#discuss-draft').fill('Pending draft at the Notes fixture boundary');
  await page.goto('about:blank');
  service.projectDiscuss?.close();
  service.projectDiscuss = null;
  const turns = [];
  service.projectDiscussOptions = {
    modelSettings: () => ({
      defaults: { model: 'test', effort: 'high' },
      models: [{ id: 'test', name: 'Test' }],
      efforts: ['high'],
    }),
    skills: async () => [],
    createProvider: () => ({
      async turn(session, message, context) {
        turns.push(message);
        if (message.recommendation?.id === 'create-delete-next')
          return fixtureCreateAndAdvance(service, session, context);
        return { text: 'Let’s discuss this note.' };
      },
      close() {},
    }),
  };
  const notes = new LocalNotes(project);
  await page.goto('/');
  const field = page.locator('#local-note-text');
  const disclosure = page.locator('#local-notes-toggle');
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await field.isVisible(), false);
  await disclosure.click();
  await field.fill('Remember the quick thought');
  await field.press('Enter');
  await page.getByRole('button', { name: 'Remember the quick thought', exact: true }).waitFor();
  assert.equal(await field.inputValue(), '');
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
  await page.reload();
  await disclosure.waitFor();
  const collapsedAfterReload = await disclosure.getAttribute('aria-expanded');
  assert.equal(collapsedAfterReload, 'false', 'Notes must stay collapsed after refresh.');
  assert.equal(await field.isVisible(), false);
  assert.equal(await disclosure.getAttribute('aria-label'), 'Expand Local notes');
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
  await page.reload();
  await disclosure.waitFor();
  const expandedAfterReload = await disclosure.getAttribute('aria-expanded');
  assert.equal(expandedAfterReload, 'true', 'Notes must stay expanded after refresh.');
  assert.equal(await field.isVisible(), true);
  assert.equal(await field.inputValue(), 'Unfinished local note');
  assert.equal(await disclosure.getAttribute('aria-label'), 'Collapse Local notes');
  await screenshot('local-notes-expanded');
  writeFileSync(
    join(output, 'local-notes-disclosure.json'),
    JSON.stringify(
      { candidate, collapsedAfterReload, expandedAfterReload, draftAfterReload: await field.inputValue() },
      null,
      2
    ) + '\n'
  );
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
    (value) => value === 'Ask me questions before creating the issue.',
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
  const registryPath = join(project, '.issues/issue-numbers.json');
  ensureIssueNumbers(project, []);
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.next = 182;
  writeFileSync(registryPath, JSON.stringify(registry));
  await page.locator('#capture-form button[type="submit"]').click();
  await page.getByRole('button', { name: 'Delete original note', exact: true }).waitFor();
  const link = page.locator('#discuss-messages').getByRole('link', { name: 'the new issue', exact: true });
  assert.match(await link.getAttribute('href'), /\?issue=/);
  assert.ok(notes.get(second.id).issueId);
  const createdPrompts = page.locator('[data-discuss-recommendations]');
  await createdPrompts.getByRole('button', { name: 'Delete note', exact: true }).waitFor();
  assert.equal(await createdPrompts.getByRole('button', { name: 'Create issue', exact: true }).count(), 0);
  assert.equal(await createdPrompts.getByRole('button', { name: 'Create, delete & next', exact: true }).count(), 0);
  assert.equal(turns.length, 1);
  await screenshot('local-note-created-issue');
  const issueId = notes.get(second.id).issueId;
  const sidebarLink = page.locator(`[data-note-id="${second.id}"]`).getByRole('link', {
    name: 'Open issue #182',
    exact: true,
  });
  await sidebarLink.waitFor();
  const conversationUrl = page.url();
  await page.reload();
  await sidebarLink.waitFor();
  const label = await sidebarLink.textContent();
  const href = await sidebarLink.getAttribute('href');
  assert.equal(href, '/?issue=' + encodeURIComponent(issueId));
  await screenshot('local-note-issue-number');
  await sidebarLink.click();
  await page.locator('#issue-heading:not([hidden])').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('issue'), issueId);
  assert.equal(await page.locator('#issue-number').textContent(), '#182');
  assert.equal(await page.locator('#issue-title').textContent(), 'An issue from the quick note');
  writeFileSync(
    join(output, 'local-note-issue-number.json'),
    JSON.stringify(
      {
        sourceCommit: candidate.revision,
        candidate,
        observedAt: new Date().toISOString(),
        noteId: second.id,
        issueId,
        label,
        href,
        retainedAfterReload: true,
        openedUrl: page.url(),
        openedIssueNumber: await page.locator('#issue-number').textContent(),
        openedIssueTitle: await page.locator('#issue-title').textContent(),
        screenshot: join(output, 'local-note-issue-number.png'),
      },
      null,
      2
    ) + '\n'
  );
  await page.goto(conversationUrl);
  await page.getByRole('button', { name: 'Delete original note', exact: true }).waitFor();
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
  const sentenceNotes = [
    { text: 'Practice at 2.5 bpm. Keep the second sentence hidden.', preview: 'Practice at 2.5 bpm.' },
    { text: 'Ready to rehearse? Keep this sentence hidden.', preview: 'Ready to rehearse?' },
    { text: '"Keep the beat!" This sentence stays in the editor.', preview: '"Keep the beat!"' },
    { text: '<Count> & listen.\nKeep this next line hidden.', preview: '<Count> & listen.' },
  ];
  for (const note of sentenceNotes) {
    await field.fill(note.text);
    await field.press('Enter');
    await page.getByRole('button', { name: note.preview, exact: true }).waitFor();
  }
  await page.reload();
  for (const note of sentenceNotes) {
    const button = page.getByRole('button', { name: note.preview, exact: true });
    await button.waitFor();
    assert.equal(await button.textContent(), note.preview);
    await button.click();
    assert.equal(await page.locator('#local-note-edit-text').inputValue(), note.text);
    await page.locator('#local-note-edit-cancel').click();
  }
  await screenshot('local-notes-first-sentences');
  await checkNoteRecommendations({ page, notes, turns, poll, screenshot, output });
  return [
    'Inline and shortcut capture persist across reloads',
    'Edit, completion and order are retained',
    'Discuss prepares quietly and only Send starts a reply',
    'Issue creation is prefilled and links back before optional deletion',
    'The sidebar retains Open issue #182 after reload and opens that issue',
    'Unsaved capture draft survives reload',
    'Multi-sentence notes show only their first sentence and retain the full text in the editor',
  ];
}

async function fixtureCreateAndAdvance(service, session, context) {
  if (session.messages.filter(({ recommendation }) => recommendation?.id === 'create-delete-next').length === 1)
    throw Error('Fixture issue creation failed.');
  const result = await service.flows.action({
    action: 'capture',
    requestId: '4a9cfdb0-6797-4eaf-8ef4-b90ff340c547',
    description: 'Create the issue from the agreed note.',
    storageProfile: resolveIssueStorage(service.root).profileId,
  });
  assert.ok(result.issue.id);
  await context.issueCreated(result.issue.id);
  return { text: 'Fixture issue created.' };
}

async function openNoteFromSidebar(page, id) {
  const row = page.locator('[data-note-id="' + id + '"]');
  await row.locator('summary').click();
  await row.getByRole('button', { name: 'Discuss', exact: true }).click();
}

async function checkNoteRecommendations({ page, notes, turns, poll, screenshot, output }) {
  const currentNotes = notes.view().notes;
  const [first, second, third] = currentNotes;
  const prompts = page.locator('[data-discuss-recommendations]');
  const names = () => prompts.getByRole('button').allTextContents();
  await openNoteFromSidebar(page, first.id);
  await prompts.getByRole('button', { name: 'Next', exact: true }).waitFor();
  const firstUrl = page.url();
  const top = await names();
  assert.ok(!top.includes('Prev'));
  const above = await prompts.evaluate((element) => {
    const draft = document.getElementById('discuss-draft');
    return (
      element.closest('form') === draft.closest('form') &&
      element.getBoundingClientRect().bottom <= draft.getBoundingClientRect().top
    );
  });
  assert.equal(above, true);
  await screenshot('note-recommendations');
  await openNoteFromSidebar(page, currentNotes.at(-1).id);
  await prompts.getByRole('button', { name: 'Prev', exact: true }).waitFor();
  const last = await names();
  assert.ok(!last.includes('Next'));
  await page.goto(firstUrl);
  await prompts.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForURL((url) => url.href !== firstUrl);
  const secondUrl = page.url();
  await prompts.getByRole('button', { name: 'Prev', exact: true }).waitFor();
  await prompts.getByRole('button', { name: 'Prev', exact: true }).click();
  await page.waitForURL(firstUrl);
  await page.goto(secondUrl);
  const combined = prompts.getByRole('button', { name: 'Create, delete & next', exact: true });
  await combined.click();
  await page.getByText('Fixture issue creation failed.', { exact: true }).waitFor();
  assert.equal(page.url(), secondUrl);
  assert.equal(notes.get(second.id).issueId, undefined);
  const sent = turns.at(-1).text;
  assert.match(sent, /After issue creation succeeds, Factory should delete source local note/);
  assert.match(sent, new RegExp(third.id));
  await combined.click();
  await page.waitForURL((url) => url.href !== secondUrl);
  await page.getByText(third.text, { exact: false }).first().waitFor();
  assert.equal(
    notes.view().notes.some(({ id }) => id === second.id),
    false
  );
  await prompts.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByText('Deleted the source note.', { exact: true }).waitFor();
  assert.equal(
    notes.view().notes.some(({ id }) => id === third.id),
    false
  );
  await poll(names, (labels) => labels.length === 0, 'Deleted note recommendations cleared');
  writeFileSync(
    join(output, 'note-recommendations.json'),
    JSON.stringify(
      {
        aboveComposer: above,
        top,
        nextAndPrev: true,
        sent,
        failureKeptSource: true,
        successDeletedAndNavigated: true,
        standaloneDelete: true,
      },
      null,
      2
    )
  );
}
