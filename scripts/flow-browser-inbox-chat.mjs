import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendMessage } from './factory-ui/conversation-store.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { withQueueConfiguration } from './flow-browser-queue-configuration.mjs';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';

function entry(project, issue, index) {
  const marker = 'Long fixture conversation message ' + index;
  appendMessage(project, issue, {
    id: 'long-fixture-' + index,
    kind: 'response',
    role: 'assistant',
    body: marker + '. '.repeat(2) + 'This retained reply keeps the conversation longer than the viewport. '.repeat(9),
  });
  return marker;
}

function position(log) {
  return log.evaluate((element) => ({
    top: element.scrollTop,
    distance: element.scrollHeight - element.clientHeight - element.scrollTop,
    overflowing: element.scrollHeight > element.clientHeight,
  }));
}

async function bottom(log, poll) {
  return poll(
    () => position(log),
    ({ distance, overflowing }) => overflowing && distance < 2,
    'The newest message is at the bottom.'
  );
}

async function scrollUp(log) {
  await log.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 3);
  });
  const result = await position(log);
  assert.ok(result.distance > 100);
  return result;
}

async function checkChat({ log, poll, addMessage, reloadHistory, reopen, screenshot, name }) {
  const opened = await bottom(log, poll);
  const marker = addMessage(40);
  await reloadHistory();
  await log.getByText(marker, { exact: false }).waitFor();
  const follow = await bottom(log, poll);
  const reading = await scrollUp(log);
  const later = addMessage(41);
  await reloadHistory();
  await log.getByText(later, { exact: false }).waitFor();
  const preserved = await position(log);
  assert.ok(Math.abs(reading.top - preserved.top) < 2, name + ' moved while reading older entries');
  await reopen();
  const reopened = await bottom(log, poll);
  await screenshot(name + '-latest');
  return { opened, follow, reading, preserved, reopened };
}

export async function inboxChatBrowserChecks({ page, service, project, root, poll, screenshot, output }) {
  const issue = '20261126-inbox-chat-reading';
  const other = '20261126-inbox-chat-second';
  for (const id of [issue, other]) {
    await writeBrowserIssue(service, { id, title: id, body: 'Retain the reader’s conversation position.' });
    for (let index = 0; index < 40; index++) entry(project, id, index);
  }
  const addMessage = (index) => entry(project, issue, index);
  await page.goto('/?issue=' + issue);
  const tab = (name) => page.getByRole('tab', { name, exact: true });
  await tab('Conversation').click();
  const block = await checkChat({
    log: page.locator('#inspector-body'),
    poll,
    addMessage,
    screenshot,
    name: 'inbox-block-chat',
    reloadHistory: () => page.locator('#refresh').click(),
    reopen: async () => {
      await tab('Details').click();
      await tab('Conversation').click();
    },
  });
  await page.locator('#inspector-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator('#issue-list [data-issue="' + other + '"]').click();
  await tab('Conversation').click();
  const switched = await bottom(page.locator('#inspector-body'), poll);
  const helper = '.agents/skills/issues/scripts';
  cpSync(join(root, helper), join(project, helper), { recursive: true });
  const classic = await withQueueConfiguration({ page, project, root }, () =>
    checkClassicChat({ page, service, project, issue, poll, screenshot, addMessage })
  );
  writeFileSync(join(output, 'inbox-chat-reading.json'), JSON.stringify({ block, switched, classic }, null, 2));
}

async function checkClassicChat({ page, service, project, issue, poll, screenshot, addMessage }) {
  initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
  await page.goto('/classic#/issue/' + issue);
  const response = await page.request.get('/api/issue?issue=' + issue);
  if (!response.ok()) throw Error(await response.text());
  const thread = page.getByRole('tab', { name: 'Issue thread', exact: true });
  const progress = page.getByRole('tab', { name: 'Progress', exact: true });
  await thread.click();
  return checkChat({
    log: page.getByRole('log', { name: 'Issue conversation' }),
    poll,
    addMessage: (index) => addMessage(index + 10),
    screenshot,
    name: 'inbox-issue-chat',
    reloadHistory: () => service.flowChanges?.notify('flow', issue),
    reopen: async () => {
      await progress.click();
      await thread.click();
    },
  });
}
