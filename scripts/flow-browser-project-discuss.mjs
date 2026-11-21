import assert from 'node:assert/strict';
import { readRequiredSkillSets } from './factory-ui/required-skills.mjs';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
        window.discussSpeechRecognition = this;
        if (window.manualDiscussDictation) return;
        setTimeout(() => {
          this.onresult?.({ results: [Object.assign([{ transcript: 'dictated words' }], { isFinal: true })] });
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
  assert.equal(await page.locator('#error-banner').isVisible(), false, 'Home must load without a selected issue.');
  assert.equal(await page.locator('#fix-branch').isVisible(), false, 'Branch repair needs a selected issue.');
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
  const activity = page.locator('.discuss-message.assistant .discuss-tool-activity');
  await activity.locator('summary').click();
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.evaluate(() => {
    const log = document.querySelector('#discuss-messages');
    if (log.scrollHeight <= log.clientHeight) throw Error('Fixture did not create a scrollable chat.');
    log.scrollTop = log.scrollHeight;
  });
  service.projectDiscuss.change(first.id, (session) => {
    const assistant = session.messages.find((message) => message.role === 'assistant');
    assistant.events.push({ text: 'Routine refresh update' });
  });
  const latestActivity = page.locator('.discuss-tool-activity pre').last();
  await poll(
    () => latestActivity.textContent(),
    (value) => value?.startsWith('Routine refresh update'),
    'Routine refresh did not update tool activity.'
  );
  assert.equal(await activity.getAttribute('open'), '');
  assert.equal(
    await latestActivity.evaluate((node) => {
      const content = node.getBoundingClientRect();
      const viewport = document.querySelector('#discuss-messages').getBoundingClientRect();
      return content.bottom > viewport.top && content.top < viewport.bottom;
    }),
    true,
    'Latest tool activity is outside the visible chat area.'
  );
  assert.equal(
    await page.locator('#discuss-messages').evaluate((log) => log.scrollHeight - log.clientHeight - log.scrollTop <= 2),
    true,
    'Routine refresh moved the chat away from the bottom.'
  );
  if (process.argv.includes('--project-discuss-refresh')) {
    await screenshot('project-discuss-refresh');
    await page.setViewportSize({ width: 1440, height: 960 });
    return;
  }
  await activity.locator('summary').click();
  await page.setViewportSize({ width: 1440, height: 960 });
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

  const dictationEvidence = { recognizer: 'Injected browser speech recognition', observations: [] };
  const dictationProofPath = join(dirname(project), 'project-discuss-dictation.json');
  async function speechResult(transcript, isFinal = true) {
    await page.evaluate(
      ({ transcript, isFinal }) => {
        window.discussSpeechRecognition.onresult({
          results: [Object.assign([{ transcript }], { isFinal })],
        });
      },
      { transcript, isFinal }
    );
  }
  async function dictate(text, { interim = null, original = '', beforeEnd = null } = {}) {
    await page.locator('#discuss-draft').fill(original);
    await page.evaluate(() => {
      window.manualDiscussDictation = true;
    });
    const before = calls.length;
    await page.locator('#discuss-mic').click();
    if (interim !== null) {
      await speechResult(interim, false);
      assert.equal(calls.length, before, 'An interim spoken command must not send.');
      assert.equal(await page.locator('#discuss-draft').inputValue(), original + (original ? ' ' : '') + interim);
    }
    await speechResult(text);
    if (beforeEnd) await beforeEnd();
    await page.evaluate(() => window.discussSpeechRecognition.onend());
    await page.locator('#discuss-mic[aria-label="Start dictation"]').waitFor();
    return before;
  }
  async function recordDictation(text, before) {
    const observation = {
      dictated: text,
      manualSend: false,
      submitted: calls.slice(before).map((message) => message.text),
      draft: await page.locator('#discuss-draft').inputValue(),
      status: await page.locator('#discuss-voice-status').textContent(),
    };
    dictationEvidence.observations.push(observation);
    writeFileSync(dictationProofPath, JSON.stringify(dictationEvidence, null, 2) + '\n');
    return observation;
  }
  const spokenSendBefore = await dictate('Explain this code go', { interim: 'Explain this code go' });
  await poll(
    () => calls.length,
    (count) => count === spokenSendBefore + 1,
    'The final spoken go did not automatically submit.'
  );
  await poll(
    () => attachedSession().status,
    (status) => status === 'idle',
    'The spoken prompt did not finish.'
  );
  assert.deepEqual((await recordDictation('Explain this code go', spokenSendBefore)).submitted, ['Explain this code']);
  for (const [text, expectedDraft] of [
    ['go', ''],
    ['Explain go in this code', 'Explain go in this code'],
    ['Explain this codego', 'Explain this codego'],
  ]) {
    const before = await dictate(text);
    await poll(
      () => attachedSession().draft.text,
      (draft) => draft === expectedDraft,
      'The unsent dictated draft was not saved.'
    );
    const observation = await recordDictation(text, before);
    assert.deepEqual(observation.submitted, [], 'Only a final command with a nonempty prompt may send.');
    assert.equal(observation.draft, expectedDraft);
  }
  const interimBefore = await dictate('Explain go in this code', { interim: 'Explain go' });
  await poll(
    () => attachedSession().draft.text,
    (draft) => draft === 'Explain go in this code',
    'The revised final transcript was not saved.'
  );
  assert.deepEqual((await recordDictation('Explain go in this code after interim go', interimBefore)).submitted, []);
  const existingDraftBefore = await dictate('GO.', { original: 'Explain the existing draft' });
  await poll(
    () => calls.length,
    (count) => count === existingDraftBefore + 1,
    'The spoken command did not submit the existing draft.'
  );
  await poll(
    () => attachedSession().status,
    (status) => status === 'idle',
    'The existing draft response did not finish.'
  );
  assert.deepEqual((await recordDictation('GO. after an existing draft', existingDraftBefore)).submitted, [
    'Explain the existing draft',
  ]);
  const whitespaceBefore = await dictate('go', { original: '   ' });
  await poll(
    () => attachedSession().draft.text,
    (draft) => draft === '',
    'The empty spoken command was not removed.'
  );
  assert.deepEqual((await recordDictation('go after whitespace', whitespaceBefore)).submitted, []);

  const editedBefore = await dictate('Explain this code go', {
    beforeEnd: async () => {
      await page.locator('#discuss-draft').fill('Edited prompt go');
      await speechResult('Late transcript go');
    },
  });
  await poll(
    () => attachedSession().draft.text,
    (draft) => draft === 'Edited prompt go',
    'A late speech result overwrote the edited draft.'
  );
  const editedObservation = await recordDictation('Final go followed by a manual draft edit', editedBefore);
  assert.deepEqual(editedObservation.submitted, [], 'Dictation must not submit a manually edited draft.');
  assert.equal(editedObservation.draft, 'Edited prompt go');
  const switchedBefore = await dictate('Explain this code go', {
    beforeEnd: async () => {
      await page.locator(`[data-discuss-conversation="${first.id}"]`).click();
      await poll(
        () => new URL(page.url()).searchParams.get('conversation'),
        (id) => id === first.id,
        'The conversation did not switch during dictation.'
      );
      await page.locator('#discuss-draft').fill('Other conversation go');
      await speechResult('Late transcript go');
    },
  });
  await poll(
    () => service.projectDiscuss.read(first.id).draft.text,
    (draft) => draft === 'Other conversation go',
    'A late speech result overwrote another conversation draft.'
  );
  const switchedObservation = await recordDictation('Final go followed by a conversation switch', switchedBefore);
  assert.deepEqual(switchedObservation.submitted, [], 'Dictation must not submit another conversation draft.');
  assert.equal(switchedObservation.draft, 'Other conversation go');
  await page.locator(`[data-discuss-conversation="${attachedConversation}"]`).click();
  await poll(
    () => new URL(page.url()).searchParams.get('conversation'),
    (id) => id === attachedConversation,
    'The dictation conversation did not reopen.'
  );

  const template = service.projectDiscuss.read(attachedConversation).messages.at(-1);
  const history = (await service.projectDiscuss.action({ action: 'create' })).selected;
  history.messages = Array.from({ length: 40 }, (_, index) => ({
    ...template,
    id: 'scroll-history-' + index,
    text: `History message ${index + 1}\n\n` + 'Retained project conversation.\n\n'.repeat(4),
    attachments: [],
    events: [],
  }));
  const historyImageUrl = new URL('/discuss-history.svg', page.url()).href;
  history.messages.at(-1).text += `\n\n![Delayed history diagram](${historyImageUrl})`;
  service.projectDiscuss.save(history);
  const scrollEvidence = { conversationId: history.id, observations: [] };
  const proofPath = join(dirname(project), 'project-discuss-scroll.json');
  const scrollMetrics = () =>
    page.locator('#discuss-messages').evaluate((log) => {
      const viewport = log.getBoundingClientRect();
      const latest = log.querySelector('.discuss-message:last-child')?.getBoundingClientRect();
      return {
        scrollTop: log.scrollTop,
        scrollHeight: log.scrollHeight,
        clientHeight: log.clientHeight,
        bottomDistance: log.scrollHeight - log.clientHeight - log.scrollTop,
        latestVisible: Boolean(latest && latest.bottom <= viewport.bottom + 1 && latest.bottom > viewport.top),
      };
    });
  async function recordScroll(stage) {
    const metrics = await scrollMetrics();
    scrollEvidence.observations.push({ stage, ...metrics });
    writeFileSync(proofPath, JSON.stringify(scrollEvidence, null, 2) + '\n');
    return metrics;
  }
  async function assertOpenedAtBottom(stage) {
    try {
      await poll(
        scrollMetrics,
        (metrics) => metrics.scrollHeight > metrics.clientHeight && metrics.bottomDistance < 2 && metrics.latestVisible,
        stage + ' did not show the latest message without scrolling.'
      );
    } finally {
      await recordScroll(stage);
    }
  }
  const initialHistory = Promise.withResolvers();
  let imageRequested = false;
  const imageLoaded = Promise.withResolvers();
  await page.route(historyImageUrl, async (route) => {
    imageRequested = true;
    await imageLoaded.promise;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="600" height="1000" fill="#303232"/></svg>',
    });
  });
  let heldHistory = false;
  await page.route(/\/api\/project-discuss(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    if (!heldHistory) {
      heldHistory = true;
      await initialHistory.promise;
    }
    await route.fulfill({ response });
  });
  await page.goto('/?projectTab=discuss&conversation=' + history.id);
  await page.locator('#discuss-messages').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#discuss-messages .discuss-message').count(), 0);
  initialHistory.resolve();
  await page.locator('[data-discuss-message="scroll-history-39"]').waitFor();
  await poll(() => imageRequested, Boolean, 'Delayed history image was not requested.');
  imageLoaded.resolve();
  await poll(
    () => page.locator('#discuss-messages img').evaluate((image) => image.complete && image.naturalHeight > 0),
    (loaded) => loaded,
    'Delayed history image did not finish rendering.'
  );
  await assertOpenedAtBottom('First opening after delayed history and image');
  await page.unroute(/\/api\/project-discuss(?:\?|$)/);
  await page.locator('#discuss-messages').hover();
  await page.mouse.wheel(0, -1000);
  await poll(scrollMetrics, (metrics) => metrics.bottomDistance > 500, 'Could not scroll to older messages.');
  const olderPosition = await recordScroll('Reading older messages');
  const updated = service.projectDiscuss.read(history.id);
  updated.messages.at(-1).text += '\n\nRefreshed latest message';
  service.projectDiscuss.save(updated);
  await page.locator('#discuss-messages').getByText('Refreshed latest message', { exact: true }).waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const refreshedPosition = await recordScroll('Polling while reading older messages');
  assert.ok(Math.abs(refreshedPosition.scrollTop - olderPosition.scrollTop) < 2, 'Polling pulled the reader down.');
  assert.equal(refreshedPosition.latestVisible, false);
  await page.locator('#project-tab-home').click();
  await page.locator('#project-tab-discuss').click();
  await poll(
    scrollMetrics,
    (metrics) => Math.abs(metrics.scrollTop - olderPosition.scrollTop) < 2,
    'Returning to Discuss lost the reading position.'
  );
  await recordScroll('Returning to Discuss preserves reading position');
  await page.unroute(historyImageUrl);
  const lateImage = Promise.withResolvers();
  await page.route(historyImageUrl, async (route) => {
    await lateImage.promise;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"/>',
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-discuss-message="scroll-history-39"]').waitFor();
  await poll(
    scrollMetrics,
    (metrics) =>
      Math.abs(metrics.scrollTop - Math.min(olderPosition.scrollTop, metrics.scrollHeight - metrics.clientHeight)) < 2,
    'Reload while an image is pending lost the saved reading position.'
  );
  await recordScroll('Reload preserves reading position while image is pending');
  await page.locator('#discuss-messages').hover();
  await page.mouse.wheel(0, -1000);
  await poll(scrollMetrics, (metrics) => metrics.bottomDistance > 500, 'Could not scroll during image loading.');
  lateImage.resolve();
  await poll(
    () => page.locator('#discuss-messages img').evaluate((image) => image.complete && image.naturalHeight > 0),
    Boolean,
    'Late image did not finish rendering.'
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterLateImage = await recordScroll('Reading older messages after pending image loads');
  assert.equal(afterLateImage.latestVisible, false, 'Late image loading pulled the reader down.');
  assert.ok(afterLateImage.bottomDistance > 500);
  await screenshot('project-discuss-scroll');
}
