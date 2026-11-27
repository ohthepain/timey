import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';
import { listIssueStorage } from './factory-ui/issue-storage-actions.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './factory-ui/project-settings.mjs';
import { inheritedIssueCaptureProfile } from './factory-ui/stores/settings.mjs';
import { withBrowserScenarioFixture } from './flow-browser-scenario-fixture.mjs';

async function capture(service, title, needsApproval) {
  const { issue } = await service.flows.capture({
    requestId: crypto.randomUUID(),
    description: title + '\n\nDisposable Discuss fixture.',
    type: 'feature',
    needsApproval,
    storageProfile: inheritedIssueCaptureProfile(service),
  });
  return issue;
}

function commandConnection(commands) {
  const threadId = 'discuss-disposition-fixture';
  return {
    turns: new Map(),
    async ready() {},
    async call(method) {
      if (method === 'skills/list') return { data: [] };
      if (['thread/start', 'thread/resume'].includes(method)) return { thread: { id: threadId } };
      if (method === 'thread/read') return { thread: { id: threadId, status: { type: 'idle' } } };
      throw Error('Unexpected discussion command ' + method);
    },
    async turn(_thread, _cwd, prompt, _schema, _inputs, _settings, receipt) {
      const [wording, entry] = commands.find(([wording]) => prompt.includes('Current request:\n' + wording));
      const turnId = crypto.randomUUID();
      this.turns.set(threadId, { started: Promise.resolve({ turn: { id: turnId } }) });
      receipt.accepted({ turnId });
      const invoke = (tool, args) =>
        this.toolHandler({ tool, arguments: args, turnId, threadId, callId: crypto.randomUUID() });
      try {
        const { issueId, ...operation } = entry;
        const snapshot = await invoke('issues_list', { issueId });
        assert.ok(snapshot.success, snapshot.contentItems[0].text);
        const { revision, reportBasis } = JSON.parse(snapshot.contentItems[0].text).issues[0];
        const result = await invoke('issue_dispose', { issueId, revision, reportBasis, ...operation });
        if (!result.success) return result.contentItems[0].text;
        const value = JSON.parse(result.contentItems[0].text);
        if (value.status === 'closed') return `Closed [the issue](${value.url}) as ${value.closure.label}.`;
        if (value.status === 'deleted') return `Permanently deleted “${value.title}”.`;
        assert.ok(value.message, wording);
        return value.message;
      } finally {
        this.turns.delete(threadId);
      }
    },
    close() {},
  };
}

function submit(page, text) {
  return page
    .locator('#discuss-draft')
    .fill(text)
    .then(() => page.locator('#discuss-send[data-discuss-action="send"]').click());
}

async function answerDeletion(page, expectedTitle, accepted) {
  const approval = page.locator('#discuss-approvals').getByRole('button', { name: 'Delete permanently' });
  const dialog = page.waitForEvent('dialog').then(async (dialog) => {
    const warning = dialog.message();
    assert.match(warning, /Permanently delete .* exclusively owned evidence/);
    assert.ok(warning.includes(expectedTitle), warning);
    await (accepted ? dialog.accept() : dialog.dismiss());
    return warning;
  });
  const [warning] = await Promise.all([dialog, approval.click()]);
  return warning;
}

export async function discussDispositionBrowserChecks({ page, service, project, root, output, poll, screenshot }) {
  return withBrowserScenarioFixture({ project, service }, async () => {
    initializeProjectLifecycle(service, { digest: readProjectSettings(project).lifecycle.digest });
    const helpers = '.agents/skills/issues/scripts';
    cpSync(join(root, helpers), join(project, helpers), { recursive: true });
    const approved = await capture(service, 'Open Discuss issue', false);
    const proposal = await capture(service, 'Pending Discuss proposal', true);
    const stale = await capture(service, 'Stale Discuss proposal', true);
    const ambiguous = await capture(service, 'Ambiguous Discuss proposal', true);
    const duplicate = await capture(service, ambiguous.title, true);
    const originalOptions = service.projectDiscussOptions;
    const originalDiscuss = service.projectDiscuss;
    const operation = (wording, action, { id, title }, extra) => [
      wording,
      { action, reference: title, issueId: id, ...extra },
    ];
    const commands = [
      operation('Close Open Discuss issue as Duplicate. Tracked by another fixture.', 'close', approved, {
        resolution: 'duplicate',
        details: 'Tracked by another fixture.',
      }),
      operation('Close Pending Discuss proposal.', 'close', proposal),
      operation('Delete Pending Discuss proposal.', 'delete', proposal),
      operation('Delete Stale Discuss proposal.', 'delete', stale),
      operation('Delete Ambiguous Discuss proposal.', 'delete', ambiguous),
    ];
    service.projectDiscuss = null;
    service.projectDiscussOptions = { connection: commandConnection(commands), skills: async () => [] };
    const observations = { sourceCommit: git(root, 'rev-parse', 'HEAD'), scenarios: [] };
    const approvedView = () => service.flows.selected(approved.id);
    const report = (issue) => service.flows.selected(issue.id);
    const inClosed = (issue) => listIssueStorage(service, 'closed').issues.some(({ id }) => id === issue.id);
    const message = (text) =>
      page.locator('#discuss-messages .assistant .discuss-message-body').getByText(text, { exact: false });
    const approval = page.locator('#discuss-approvals').getByRole('button', { name: 'Delete permanently' });
    try {
      await page.goto('/?projectTab=discuss');
      await page.locator('#discuss-new').click();
      await submit(page, commands[0][0]);
      await message('as Duplicate.').waitFor();
      const link = await page
        .locator('#discuss-messages')
        .getByRole('link', { name: 'the issue' })
        .getAttribute('href');
      assert.equal(link, '/?issue=' + approved.id);
      const { closed, closure } = approvedView();
      assert.ok(closed && inClosed(approved));
      assert.equal(closure.reason, 'duplicate');
      assert.equal(closure.details, 'Tracked by another fixture.');
      observations.scenarios.push({ operation: 'close', closed, closure, link });

      const before = report(proposal).content;
      await submit(page, commands[1][0]);
      await message('It can be permanently deleted if you ask to delete it.').waitFor();
      assert.equal(report(proposal).content, before);
      assert.equal(await approval.count(), 0);
      observations.scenarios.push({ operation: 'close unapproved', unchanged: true, confirmationOffered: false });

      await submit(page, commands[2][0]);
      await approval.waitFor();
      assert.equal(report(proposal).content, before);
      await screenshot('project-discuss-proposal-confirmation');
      const cancelledWarning = await answerDeletion(page, proposal.title, false);
      await message('was cancelled.').waitFor();
      assert.equal(report(proposal).content, before);
      observations.scenarios.push({ operation: 'cancel deletion', unchanged: true, warning: cancelledWarning });

      await submit(page, commands[2][0]);
      await approval.waitFor();
      assert.equal(report(proposal).content, before);
      const confirmedWarning = await answerDeletion(page, proposal.title, true);
      await message('Permanently deleted “' + proposal.title + '”.').waitFor();
      assert.throws(() => report(proposal), /no longer exists/);
      assert.equal(inClosed(proposal), false);
      observations.scenarios.push({
        operation: 'confirm deletion',
        presentBeforeConfirmation: true,
        removed: true,
        inClosed: false,
        warning: confirmedWarning,
      });

      await submit(page, commands[3][0]);
      await approval.waitFor();
      const revision = service.flows.read(report(stale)).revision;
      await service.flows.action({ action: 'approve-issue', issueId: stale.id, revision });
      const afterApproval = report(stale).content;
      await answerDeletion(page, stale.title, true);
      await message(/changed|no longer awaiting approval/).waitFor();
      assert.equal(report(stale).content, afterApproval);
      assert.equal(inClosed(stale), false);
      observations.scenarios.push({ operation: 'approve before confirmation', approvedProposalPreserved: true });

      const ambiguousBefore = [ambiguous, duplicate].map((issue) => report(issue).content);
      await submit(page, commands[4][0]);
      await message('More than one open issue matches.').waitFor();
      assert.equal(await approval.count(), 0);
      assert.deepEqual(
        [ambiguous, duplicate].map((issue) => report(issue).content),
        ambiguousBefore
      );
      observations.scenarios.push({
        operation: 'ambiguous deletion',
        bothProposalsPreserved: true,
        confirmationOffered: false,
      });
      const blocks = await poll(
        () => service.flows.read(approvedView()).blocks,
        () => !service.flows.closureBusy(approved.id),
        'Fixture closure cleanup did not finish.'
      );
      assert.ok(blocks.every(({ kind, attempts }) => ['close', 'cleanup'].includes(kind) || attempts.length === 0));
      observations.executedBlocks = blocks.filter(({ attempts }) => attempts.length > 0).map(({ kind }) => kind);
    } finally {
      writeFileSync(join(output, 'project-discuss-disposition.json'), JSON.stringify(observations, null, 2) + '\n');
      service.projectDiscuss?.close();
      service.projectDiscuss = originalDiscuss;
      service.projectDiscussOptions = originalOptions;
    }
  });
}
