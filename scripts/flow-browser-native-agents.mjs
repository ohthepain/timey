import assert from 'node:assert/strict';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';

export async function nativeAgentBrowserChecks({ page, service, project, poll, screenshot }) {
  initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
  const previous = service.flows.executor;
  let pending;
  service.flows.executor = {
    async run(context) {
      const completion = Promise.withResolvers();
      pending = { ...context, completion };
      return completion.promise;
    },
    approvals(issueId) {
      if (!pending || pending.issue.id !== issueId) return [];
      const choices = {
        question: {
          params: { questions: [{ id: 'output', question: 'Which output?', options: [{ label: 'Summary' }] }] },
          options: [],
        },
        permission: {
          params: { command: 'Edit fixture', reason: 'Write the authorized fixture change.' },
          options: [
            { id: 'option:0', label: 'Allow once' },
            { id: 'option:1', label: 'Decline' },
          ],
        },
      };
      const kind = pending.issue.id.endsWith('question') ? 'question' : 'permission';
      return [
        { requestId: 'native-request', blockId: pending.block.id, attemptId: pending.attempt.id, ...choices[kind] },
      ];
    },

    answer(issueId, blockId, attemptId, requestId, response) {
      assert.equal(issueId, pending.issue.id);
      assert.equal(blockId, pending.block.id);
      assert.equal(attemptId, pending.attempt.id);
      assert.equal(requestId, 'native-request');
      assert.deepEqual(
        response,
        issueId.endsWith('question') ? { answers: { output: 'Summary' } } : { decision: 'option:0' }
      );
      pending.completion.resolve({ summary: 'The native input was handled.' });
      pending = null;
    },
    close() {
      pending?.completion.resolve({ summary: 'Browser fixture stopped.' });
    },
  };
  try {
    for (const kind of ['permission', 'question']) {
      const id = '20261123-native-' + kind;
      await writeBrowserIssue(project, { id, title: 'Native ' + kind, body: 'Exercise explicit agent input.' });
    }
    await ensureProjectStores(service);
    for (const kind of ['permission', 'question']) {
      const id = '20261123-native-' + kind;
      const issue = service.flows.selected(id);
      const flow = service.flows.read(issue);
      const block = flow.blocks.find(({ kind }) => kind === 'work');
      await service.flows.action({ action: 'start', issueId: id, blockId: block.id, revision: flow.revision });
      await poll(() => Boolean(pending), Boolean, 'The native input fixture started.');
      await page.goto('/?issue=' + id + '&block=' + block.id);
      await page.getByRole('button', { name: 'Open request', exact: true }).click();
      assert.equal(await page.locator('#issue-results-title').innerText(), 'Needs your input');
      const card = page.locator('[data-agent-approval="native-request"]');
      await card.waitFor();
      if (kind === 'question') {
        await card.locator('[data-agent-question="output"]').fill('Summary');
        await page.locator('#refresh').click();
        assert.equal(await card.locator('[data-agent-question="output"]').inputValue(), 'Summary');
        await screenshot('native-agent-question');
        await card.getByRole('button', { name: 'Send answers', exact: true }).click();
      } else {
        await screenshot('native-agent-permission');
        await card.getByRole('button', { name: 'Allow once', exact: true }).click();
      }
      await poll(
        () => service.flows.active.has(id),
        (active) => !active,
        'The bound native input completed.'
      );
    }
  } finally {
    service.flows.executor.close();
    await Promise.allSettled([...service.flows.active.values()].map(({ task }) => task));
    service.flows.executor = previous;
  }
}
