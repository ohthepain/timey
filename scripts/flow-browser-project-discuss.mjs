import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function projectDiscussBrowserChecks({ page, service, project, poll, screenshot }) {
  const calls = [];
  const choices = {
    defaults: { model: 'model-a', effort: 'high' },
    models: [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
    ],
    efforts: ['high', 'low'],
  };
  service.projectDiscussOptions = {
    modelSettings: () => choices,
    skills: async () => [{ name: 'grilling', description: 'Ask questions', source: 'Project', icon: '✦' }],
    createProvider: () => ({
      async turn(session, message, { signal, event, retain }) {
        calls.push(message);
        retain({ threadId: 'fixture-' + session.id, startup: { status: 'ready' } });
        event({ method: 'item/agentMessage/delta', params: { delta: 'Live partial response' } });
        event({
          method: 'item/completed',
          params: { item: { type: 'commandExecution', command: 'fixture inspect', status: 'completed' } },
        });
        if (message.text === 'Hold response')
          await new Promise((resolve, reject) =>
            signal.addEventListener('abort', () => reject(Error('Stopped by user')), { once: true })
          );
        return {
          text: '## Project answer\n\n**Retained** reply.\n\n```js\nconst saved = true;\n```',
          suggestion: 'Explain the project structure',
        };
      },
      async stop() {},
      async steer() {},
      async answer() {},
      close() {},
    }),
  };
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        setTimeout(() => {
          this.onresult?.({ results: [[{ transcript: 'dictated words' }]] });
          this.onend?.();
        }, 30);
      }
      stop() {
        this.onend?.();
      }
    };
  });
  await page.goto('/');
  await page.locator('#project-tab-home').waitFor();
  assert.equal(await page.locator('#project-tab-home').getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Start an investigation', exact: true }).waitFor();
  assert.equal(calls.length, 0);
  await page.locator('#project-tab-discuss').click();
  await page.locator('#discuss-new').waitFor();
  await page.locator('#discuss-new').click();
  await page.locator('#discuss-draft:not(:disabled)').waitFor();
  await page.locator('#discuss-draft').fill('First project question');
  await page.locator('#discuss-send').click();
  await page.locator('#discuss-messages h2').filter({ hasText: 'Project answer' }).waitFor();
  assert.equal(calls.length, 1);
  assert.equal(await page.locator('#discuss-messages [data-discuss-copy-code]').count(), 1);
  const first = service.projectDiscuss.view().selected;
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[0].settings.model, 'model-a');
  await page.locator('#discuss-draft').focus();
  await page.locator('#discuss-draft').press('Tab');
  assert.equal(await page.locator('#discuss-draft').inputValue(), 'Explain the project structure');
  assert.equal(calls.length, 1, 'Tab must not submit a suggestion');
  await page.locator('#discuss-draft').fill('Persisted unsent draft');
  await page.locator('#project-tab-home').click();
  await page.locator('#project-tab-discuss').click();
  assert.equal(await page.locator('#discuss-draft').inputValue(), 'Persisted unsent draft');
  await page.reload();
  await page.locator('#project-tab-discuss').click();
  await page.locator('#discuss-draft').waitFor();
  await poll(
    () => page.locator('#discuss-draft').inputValue(),
    (value) => value === 'Persisted unsent draft',
    'Draft was lost after reload.'
  );
  await page.locator('#discuss-mic').click();
  await poll(
    () => page.locator('#discuss-draft').inputValue(),
    (value) => value.endsWith('dictated words'),
    'Dictation was not added to editable input.'
  );
  assert.equal(calls.length, 1, 'Dictation must not send');
  await page.locator('#discuss-draft').fill('/');
  await page.locator('#discuss-form .skill-option').filter({ hasText: 'grilling' }).waitFor();
  await page.locator('#discuss-draft').press('Enter');
  assert.equal(calls.length, 1, 'Skill picker Enter must not send');
  await page.locator('#discuss-draft').fill('With selected skill');
  await page.locator('#discuss-send').click();
  await poll(
    () => calls.length,
    (value) => value === 2,
    'Skill message did not dispatch.'
  );
  assert.deepEqual(calls[1].settings.skills, ['grilling']);
  await poll(
    () => service.projectDiscuss.read(first.id).status,
    (value) => value === 'idle',
    'Second response did not finish.'
  );
  await page.locator('#discuss-new').click();
  await page.locator('#discuss-model').selectOption('model-b');
  await page.locator('#discuss-effort').selectOption('low');
  await page.locator('#discuss-clarification').selectOption('grill-with-docs');
  const original = join(project, 'attachment.txt');
  writeFileSync(original, 'Retained attachment');
  await page.locator('#discuss-files').setInputFiles(original);
  await page.locator('#discuss-draft-attachments').getByText('attachment.txt', { exact: false }).waitFor();
  await page.locator('#discuss-draft').fill('Check attached file');
  await page.locator('#discuss-send').click();
  await poll(
    () => calls.length,
    (value) => value === 3,
    'Attachment message did not dispatch.'
  );
  writeFileSync(original, 'Changed original');
  assert.equal(readFileSync(calls[2].attachments[0].path, 'utf8'), 'Retained attachment');
  assert.equal(calls[2].settings.model, 'model-b');
  assert.equal(calls[2].settings.effort, 'low');
  assert.equal(calls[2].settings.clarificationSkill, 'grill-with-docs');
  const download = await page.request.get(service.projectDiscuss.view().selected.messages[0].attachments[0].url);
  assert.equal(await download.text(), 'Retained attachment');
  await poll(
    () => service.projectDiscuss.view().selected.status,
    (value) => value === 'idle',
    'Attached response did not finish.'
  );
  await page.locator('#discuss-draft').fill('Hold response');
  await page.locator('#discuss-send').click();
  await page.locator('#discuss-messages').getByText('Live partial response', { exact: true }).waitFor();
  await page.locator('#discuss-draft').fill('Queued question');
  await page.locator('#discuss-send').click();
  await page.locator('#discuss-queue [data-discuss-queue-edit]').waitFor();
  await page.locator('#discuss-queue [data-discuss-queue-edit]').click();
  await page.locator('#discuss-draft').fill('Edited queued question');
  await page.locator('#discuss-send').click();
  await poll(
    () => service.projectDiscuss.view().selected.queue[0]?.text,
    (value) => value === 'Edited queued question',
    'Queued edit was not retained.'
  );
  await page.locator('#discuss-stop').click();
  await page.locator('#discuss-resume').waitFor();
  assert.equal(calls.length, 4);
  await page.locator('#discuss-queue [data-discuss-queue-remove]').click();
  await poll(
    () => service.projectDiscuss.view().selected.queue.length,
    (value) => value === 0,
    'Queued remove was not retained.'
  );
  const held = service.projectDiscuss
    .view()
    .selected.messages.find((m) => m.role === 'user' && m.text === 'Hold response');
  await page.locator(`[data-discuss-edit="${held.id}"]`).click();
  assert.equal(await page.locator('#discuss-draft').inputValue(), 'Hold response');
  assert.equal(calls.length, 4);
  await screenshot('project-discuss');
  await page.setViewportSize({ width: 640, height: 900 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'Discuss overflows narrow viewport'
  );
  await page.setViewportSize({ width: 1440, height: 960 });
}
