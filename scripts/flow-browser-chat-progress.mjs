import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';
import { resolveIssueStorage } from './factory-ui/stores/settings.mjs';
import { assertUserMessageBox } from './flow-browser-chat-style.mjs';

function command(emit, id, text, output, exitCode = 0) {
  const item = { id, type: 'commandExecution', command: text };
  emit({ method: 'item/started', params: { item } });
  emit({ method: 'item/commandExecution/outputDelta', params: { itemId: id, delta: output } });
  emit({ method: 'item/completed', params: { item: { ...item, exitCode } } });
}

function commentary(emit, id, text) {
  emit({ method: 'item/agentMessage/delta', params: { itemId: id, delta: text } });
  emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id, phase: 'commentary', text } } });
}

async function exerciseChat({ page, chat, emit, reopen, waitForApproval, finish, screenshot, name }) {
  const live = chat.locator('.chat-live .SparkleText');
  await live.waitFor();
  await live.evaluate((node) => (window.originalProgressLine = node));
  command(emit, 'search', 'rg references src', 'src/index.js:1');
  await live.filter({ hasText: /^Exploring$/ }).waitFor();
  command(emit, 'miss', 'rg deprecated src', '', 1);
  const liveDetails = chat.locator('.chat-live details');
  await liveDetails.getByText('2 commands').waitFor();
  assert.equal(await live.count(), 1);
  assert.equal(await live.evaluate((node) => node === window.originalProgressLine), true);
  assert.equal(await liveDetails.evaluate((node) => node.open), false);
  assert.equal(await chat.locator('[role=alert]').count(), 0);
  await liveDetails.locator('summary').click();
  const ordered = await liveDetails.locator('code').allTextContents();
  assert.deepEqual(ordered, ['rg references src', 'rg deprecated src']);
  await liveDetails.getByText('src/index.js:1', { exact: true }).waitFor();
  commentary(emit, 'found', '[Milestone] Found the references in the issue entry point.');
  command(emit, 'edit', 'apply_patch issue.js', 'Updated issue.js');
  commentary(emit, 'verify', '[Progress: Verifying] Checking the edited path.');
  command(emit, 'test', 'node --test issue.check.mjs', '1 passed');
  await live.filter({ hasText: /^Verifying · Checking the edited path\.$/ }).waitFor();
  assert.equal(await chat.locator('.discuss-message-body').filter({ hasText: '[Progress:' }).count(), 0);
  assert.equal(await live.count(), 1);
  const milestone = chat.locator('.chat-milestone').filter({ hasText: 'Found the references' });
  await milestone.waitFor();
  assert.equal(await milestone.locator('details').evaluate((node) => node.open), false);
  await page.reload();
  await reopen();
  await live.filter({ hasText: /^Verifying · Checking the edited path\.$/ }).waitFor();
  await milestone.waitFor();
  const animation = await live.evaluate((node) => getComputedStyle(node).animationName);
  assert.equal(animation, 'sparkle-text');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotion = await live.evaluate((node) => getComputedStyle(node).animationName);
  assert.equal(reducedMotion, 'none');
  await screenshot(name + '-reduced-motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await waitForApproval();
  commentary(emit, 'blocked', '[Blocked] Verification needs a saved approval.');
  await chat.getByRole('alert').filter({ hasText: 'Verification needs a saved approval.' }).waitFor();
  assert.equal(await liveDetails.evaluate((node) => node.open), false);
  await finish();
  const reply = chat.locator('[data-discuss-message]').filter({ hasText: 'Final progress proof reply.' });
  await reply.waitFor();
  assert.equal(
    await reply.locator('.discuss-message-body').getAttribute('data-ai-source'),
    'Final progress proof reply.'
  );
  await live.waitFor({ state: 'detached' });
  const remaining = reply.locator('details.chat-commands');
  assert.equal(await remaining.evaluate((node) => node.open), false);
  await remaining.locator('summary').click();
  const trailing = await remaining.locator('code').allTextContents();
  assert.deepEqual(trailing, ['apply_patch issue.js', 'node --test issue.check.mjs']);
  await remaining.getByText('1 passed', { exact: true }).waitFor();
  await page.reload();
  await reopen();
  await reply.waitFor();
  await milestone.waitFor();
  assert.equal(await live.count(), 0);
  await screenshot(name + '-retained');
  return {
    ordered,
    trailing,
    animation,
    reducedMotion,
    milestones: await chat.locator('.chat-milestone').allTextContents(),
  };
}

export async function chatProgressBrowserChecks({ page, service, project, poll, screenshot, output, clickAction }) {
  initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
  await ensureProjectStores(service);
  const previous = service.flows.executor;
  const flowDone = Promise.withResolvers();
  let flow;
  let needsInput = false;
  service.flows.executor = {
    async run(context) {
      flow = context;
      return flowDone.promise;
    },
    approvals() {
      return needsInput
        ? [{ requestId: 'verify', blockId: flow.block.id, attemptId: flow.attempt.id, params: {} }]
        : [];
    },
    close() {},
  };
  const results = {};
  try {
    const { issue } = await service.flows.action({
      action: 'capture',
      requestId: randomUUID(),
      description: 'Record semantic developer activity in the issue conversation.',
      storageProfile: resolveIssueStorage(project).profileId,
    });
    const saved = service.flows.read(service.flows.selected(issue.id));
    const block = saved.blocks.find(({ kind }) => kind === 'work');
    await service.flows.action({ action: 'start', issueId: issue.id, blockId: block.id, revision: saved.revision });
    await poll(() => flow, Boolean, 'Issue work started');
    const reopen = async () => {
      await page.locator('#tab-conversation').click();
    };
    await page.goto('/?issue=' + issue.id + '&block=' + block.id);
    await reopen();
    results.issue = await exerciseChat({
      page,
      screenshot,
      reopen,
      name: 'issue-chat',
      chat: page.locator('#inspector-body'),
      emit: flow.onEvent,
      waitForApproval: async () => {
        needsInput = true;
        await page.locator('#refresh').click();
        await page.locator('#issue-input-continue').waitFor();
      },
      finish: async () => {
        needsInput = false;
        flowDone.resolve({ summary: 'Final progress proof reply.' });
      },
    });
    await poll(() => !service.flows.active.has(issue.id), Boolean, 'Issue work released its claim');
    const userNote = 'Retain the completed progress with this note.';
    await page.locator('#comment-form [name="comment"]').fill(userNote);
    await clickAction(page.locator('#comment-form button[type="submit"]'));
    results.blockUserBox = await assertUserMessageBox(page.locator('#inspector-body'), userNote);
    await screenshot('block-conversation-user-message');
  } finally {
    flowDone.resolve({ summary: 'Fixture cleanup.' });
    service.flows.executor = previous;
  }
  const discussionDone = Promise.withResolvers();
  let discuss;
  service.projectDiscuss?.close();
  service.projectDiscuss = null;
  service.projectDiscussOptions = {
    skills: async () => [],
    createProvider: () => ({
      async turn(_session, _message, context) {
        discuss = context;
        return discussionDone.promise;
      },
      close() {},
    }),
  };
  try {
    await page.goto('/?projectTab=discuss');
    await page.locator('#discuss-new').click();
    await page.locator('#discuss-draft').fill('Follow the activity');
    await page.locator('#discuss-send').click();
    await poll(() => discuss, Boolean, 'Project Discuss response started');
    results.discuss = await exerciseChat({
      page,
      screenshot,
      name: 'project-discuss-chat',
      reopen: async () => {},
      chat: page.locator('#discuss-messages'),
      emit: discuss.event,
      waitForApproval: async () => {
        discuss.event({
          method: 'ui/approval',
          params: {
            requestId: 'verify',
            method: 'item/commandExecution/requestApproval',
            params: { command: 'Review fixture verification' },
          },
        });
        await page.locator('#discuss-approvals').getByText('Review fixture verification').waitFor();
      },
      finish: async () =>
        discussionDone.resolve({
          text: '[Progress: Verifying] Checking the edited path.\nFinal progress proof reply.',
        }),
    });
  } finally {
    discussionDone.resolve({ text: 'Fixture cleanup.' });
    writeFileSync(join(output, 'chat-progress.json'), JSON.stringify(results, null, 2) + '\n');
  }
}
