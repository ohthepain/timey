import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOptions, scopedCommandApproval } from './factory-ui/approval-options.mjs';
import { writeBrowserIssue } from './flow-browser-fixture.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';

function deliveryRequest(target, cwd) {
  const repository = 'timey-fixture/disposable-delivery';
  return {
    id: 'native-request',
    method: 'item/commandExecution/requestApproval',
    params: {
      cwd,
      reason:
        'The disposable delivery is paused for permission. Approving allows a source branch push, a PR creation, and a protected PR merge. ' +
        `Repository ${repository}. Source branch proof-source. Protected target branch ${target}.`,
      command:
        `git push https://github.com/${repository}.git HEAD:refs/heads/proof-source && ` +
        `gh pr create --repo ${repository} --head proof-source --base ${target} && ` +
        `gh pr merge proof-source --repo ${repository} --merge`,
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
    },
  };
}

async function exercisePermissionReview({ page, poll, screenshot, changeTarget, writes }) {
  const blocker = page.locator('#issue-blocker');
  const review = blocker.getByRole('button', { name: 'Review permission' });
  const dialog = page.locator('#permission-review-dialog');
  const approve = dialog.locator('#permission-review-approve');
  await blocker.getByText('Permission required', { exact: true }).waitFor();
  const notice = await blocker.innerText();
  assert.match(notice, /disposable delivery is paused for permission/i);
  assert.match(notice, /approving allows a source branch push, a PR creation, and a protected PR merge/i);
  assert.ok(await blocker.getByRole('button', { name: 'Open block details' }).isVisible());
  await screenshot('native-permission-blocked-message');

  const openReview = async () => {
    await review.click();
    await dialog.waitFor();
    return dialog.innerText();
  };
  const assertPaused = async () => {
    await dialog.waitFor({ state: 'hidden' });
    await review.waitFor();
    assert.deepEqual(writes, []);
    return await blocker.innerText();
  };

  const originalScope = await openReview();
  for (const resource of ['timey-fixture/disposable-delivery', 'proof-source', 'protected-proof-target'])
    assert.ok(originalScope.includes(resource), originalScope);
  assert.match(originalScope, /git push .*gh pr create .*gh pr merge/s);
  assert.equal(await dialog.getByRole('button', { name: /allow for this chat/i }).count(), 0);
  await screenshot('native-permission-review');
  await dialog.locator('#permission-review-decline').click();
  const afterDecline = await assertPaused();

  await openReview();
  await page.keyboard.press('Escape');
  const afterDismiss = await assertPaused();

  await openReview();
  changeTarget('updated-protected-target');
  await poll(
    () => approve.isDisabled(),
    Boolean,
    'Approval stayed available on an open review after the protected target changed.'
  );
  assert.deepEqual(writes, []);
  await page.keyboard.press('Escape');
  const updatedScope = await openReview();
  assert.match(updatedScope, /--base updated-protected-target/);
  assert.doesNotMatch(updatedScope, /--base protected-proof-target/);
  await screenshot('native-permission-updated-review');
  await approve.click();
  return { notice, originalScope, afterDecline, afterDismiss, updatedScope };
}

export async function nativeAgentBrowserChecks({ page, service, project, poll, screenshot }) {
  initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
  const previous = service.flows.executor;
  const writes = [];
  let reviewProof;
  let request = deliveryRequest('protected-proof-target', project);
  let pending;
  service.flows.executor = {
    async run(context) {
      const completion = Promise.withResolvers();
      pending = { ...context, completion };
      return completion.promise;
    },
    approvals(issueId) {
      if (!pending || pending.issue.id !== issueId) return [];
      const approval = { requestId: request.id, blockId: pending.block.id, attemptId: pending.attempt.id };
      if (issueId.endsWith('question'))
        return [
          {
            ...approval,
            params: { questions: [{ id: 'output', question: 'Which output?', options: [{ label: 'Summary' }] }] },
            options: [],
          },
        ];
      return [
        {
          ...approval,
          params: request.params,
          options: approvalOptions(request),
          scope: scopedCommandApproval(request),
        },
      ];
    },

    answer(issueId, blockId, attemptId, requestId, response) {
      assert.equal(issueId, pending.issue.id);
      assert.equal(blockId, pending.block.id);
      assert.equal(attemptId, pending.attempt.id);
      assert.equal(requestId, 'native-request');
      if (issueId.endsWith('question')) assert.deepEqual(response, { answers: { output: 'Summary' } });
      else {
        assert.deepEqual(response, { decision: 'option:0', permissionToken: scopedCommandApproval(request).token });
        writes.push(request.params.command);
      }
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
      if (kind === 'question') {
        await page.locator('#issue-input-continue').click();
        assert.equal(await page.locator('#issue-results-title').innerText(), 'Needs your input');
        assert.equal(await page.locator('#issue-permission-review').isVisible(), false);
        const card = page.locator('[data-agent-approval="native-request"]');
        await card.locator('[data-agent-question="output"]').fill('Summary');
        await page.locator('#refresh').click();
        assert.equal(await card.locator('[data-agent-question="output"]').inputValue(), 'Summary');
        await screenshot('native-agent-question');
        await card.locator('button[data-action="agent-answer"]:not([data-decision])').click();
      } else {
        reviewProof = await exercisePermissionReview({
          page,
          poll,
          screenshot,
          writes,
          changeTarget(target) {
            request = deliveryRequest(target, project);
            service.flowChanges.notify('flow', id);
          },
        });
      }
      await poll(
        () => service.flows.active.has(id),
        (active) => !active,
        'The bound native input completed.'
      );
      await page.locator('#issue-permission-review').waitFor({ state: 'hidden' });
    }
    assert.deepEqual(writes, [request.params.command]);
    writeFileSync(
      join(dirname(project), 'native-permission-review.json'),
      JSON.stringify(
        { ...reviewProof, fixtureWrites: writes, reviewHiddenForQuestionAndAfterApproval: true },
        null,
        2
      ) + '\n'
    );
  } finally {
    service.flows.executor.close();
    await Promise.allSettled([...service.flows.active.values()].map(({ task }) => task));
    service.flows.executor = previous;
  }
}
