import assert from 'node:assert/strict';
import { readRequiredSkillSets } from './factory-ui/required-skills.mjs';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function projectDiscussBrowserChecks({ page, service, project, poll, screenshot }) {
  const requiredSkillSets = readRequiredSkillSets(process.cwd());
  const skillsDirectory = join(project, 'user/skills');
  mkdirSync(skillsDirectory, { recursive: true });
  writeFileSync(join(skillsDirectory, 'requirements.json'), JSON.stringify(requiredSkillSets));
  const calls = [];
  let availableSkills = ['grilling', 'grill-with-docs'].map((name) => ({
    name,
    description: 'Ask questions',
    source: 'Project',
    icon: '✦',
  }));
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
    skills: async () => availableSkills,
    createProvider: () => ({
      async turn(session, message, { signal, event, retain }) {
        calls.push(message);
        if (message.text === 'Fail response') throw Error('Fixture provider failure');
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
  const attachedConversation = await poll(
    () => new URL(page.url()).searchParams.get('conversation'),
    (id) => id && id !== first.id,
    'New discussion must select its own conversation.'
  );
  const attachedSession = () => service.projectDiscuss.view(attachedConversation).selected;
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
  const attachment = page.locator('#discuss-messages').getByRole('link', { name: 'attachment.txt', exact: true });
  const [download] = await Promise.all([page.waitForEvent('download'), attachment.click()]);
  assert.equal(download.suggestedFilename(), 'attachment.txt');
  assert.equal(readFileSync(await download.path(), 'utf8'), 'Retained attachment');
  await poll(
    () => attachedSession().status,
    (value) => value === 'idle',
    'Attached response did not finish.'
  );
  await page.locator('#discuss-draft').fill('Hold response');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.locator('#discuss-messages').getByText('Hold response', { exact: true }).waitFor();
  await page.locator('#discuss-messages').getByText('Live partial response', { exact: true }).waitFor();
  await page.locator('#discuss-draft').fill('Queued question');
  await page.locator('#discuss-draft').press('Enter');
  await page.locator('#discuss-queue [data-discuss-queue-edit]').waitFor();
  await page.locator('#discuss-queue [data-discuss-queue-edit]').click();
  await page.locator('#discuss-draft').fill('Edited queued question');
  await page.locator('#discuss-draft').press('Enter');
  await poll(
    () => attachedSession().queue[0]?.text,
    (value) => value === 'Edited queued question',
    'Queued edit was not retained.'
  );
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await page.locator('#discuss-resume').waitFor();
  assert.equal(calls.length, 4);
  await page.locator('#discuss-queue [data-discuss-queue-remove]').click();
  await poll(
    () => attachedSession().queue.length,
    (value) => value === 0,
    'Queued remove was not retained.'
  );
  const held = attachedSession().messages.find((m) => m.role === 'user' && m.text === 'Hold response');
  await page.locator(`[data-discuss-edit="${held.id}"]`).click();
  assert.equal(await page.locator('#discuss-draft').inputValue(), 'Hold response');
  assert.equal(calls.length, 4);
  await page.locator('#discuss-draft').fill('Keep my draft during setup');
  assert.equal(await page.locator('#discuss-clarification option').last().textContent(), 'No Grilling');
  await page.locator('#discuss-clarification').selectOption('__setup_skills__');
  await page.locator('#discuss-resume').click();
  await poll(
    () => calls.length,
    (value) => value === 5,
    'Skill setup prompt did not dispatch.'
  );
  assert.equal(calls[4].settings.clarificationSkill, 'none');
  assert.deepEqual(calls[4].settings.skills, []);
  assert.match(calls[4].text, /Set up the missing supported skill collections/);
  assert.equal(await page.locator('#discuss-draft').inputValue(), 'Keep my draft during setup');
  availableSkills = requiredSkillSets.flatMap((set) => set.skills.map((name) => ({ name })));
  await page.locator('#discuss-refresh-skills').click();
  await poll(
    () => page.locator('#discuss-clarification option[value="__setup_skills__"]').count(),
    (count) => count === 0,
    'Setup option remained after all listed skills were installed.'
  );
  await page.locator('#discuss-clarification').selectOption('none');
  await screenshot('project-discuss');
  await page.setViewportSize({ width: 640, height: 900 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'Discuss overflows narrow viewport'
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('#discuss-draft').fill('Fail response');
  await page.locator('#discuss-draft').press('Enter');
  await poll(
    () => attachedSession().status,
    (status) => status === 'paused',
    'Failed chat did not pause'
  );
  await page.locator('#discuss-draft').fill('Continue after failure');
  await page.locator('#discuss-draft').press('Enter');
  await poll(
    () => attachedSession().messages.at(-1)?.status,
    (status) => status === 'completed',
    'New message remained queued after failure'
  );
  assert.equal(calls.at(-1).text, 'Continue after failure');
}
