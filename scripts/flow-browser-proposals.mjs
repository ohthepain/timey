import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureRoute } from './flow-browser-routes.mjs';
import { updateStoredIssueMetadata } from './factory-ui/issue-report-storage.mjs';

async function beginUnrelatedWork(service, issueId, proposalId) {
  const stores = service.projectStores;
  const flow = (await stores.readIssue(issueId)).flow;
  const block = flow.blocks.find(({ kind }) => kind === 'work');
  const attempt = service.flows.makeAttempt(
    flow,
    service.flows.selected(issueId),
    block,
    service.flows.catalog.read().entries
  );
  const { owner } = await stores.beginAttempt({
    issueId,
    blockId: block.id,
    attempt,
    expectedRevision: flow.revision,
    operationId: 'proposal-fixture-work',
  });
  const pending = await stores.coordination.operation('proposal-fixture-pending', 'save-flow', { issueId });
  const only = await stores.artifacts.put({ body: 'Exclusive proposal evidence.' });
  const shared = await stores.artifacts.put({ body: 'Evidence shared with the unrelated work.' });
  await stores.coordination.commit(
    'proposal-fixture-evidence',
    [issueId, proposalId].map((id) => ({ key: 'evidence/' + id, revision: null })),
    [
      { key: 'evidence/' + issueId, value: { files: [{ ref: shared }] } },
      { key: 'evidence/' + proposalId, value: { files: [{ ref: shared }, { ref: only }] } },
    ]
  );
  return { owner, attempt, pending, only, shared };
}

async function checkRemovedEvidence(stores, proposalId, { only, shared }) {
  const removed = await stores.coordination.get('catalog/' + proposalId);
  assert.equal(removed.value.state, 'deleted');
  assert.equal(await stores.coordination.get('evidence/' + proposalId), null);
  assert.equal(await stores.artifacts.inspect(only), null);
  const sharedBody = (await stores.artifacts.get(shared)).toString();
  assert.equal(sharedBody, 'Evidence shared with the unrelated work.');
  return sharedBody;
}

async function finishUnrelatedWork(stores, { owner, attempt, pending }) {
  assert.deepEqual((await stores.coordination.owned(owner)).value, owner);
  assert.equal((await stores.coordination.get(pending.key)).value.status, 'pending');
  await stores.coordination.updateOperation(pending, { status: 'confirmed' }, 'continued');
  stores.recordProgress(owner, { message: 'Fixture continued after proposal deletion.' });
  const flow = await stores.finishAttempt(owner, {
    result: { status: 'completed', summary: 'Unrelated fixture work completed.' },
    operationId: 'proposal-fixture-work-finished',
  });
  const saved = flow.blocks.flatMap(({ attempts }) => attempts).find(({ id }) => id === attempt.id);
  assert.equal(saved.status, 'completed');
  return { issueId: owner.issueId, attemptId: attempt.id, status: saved.status };
}

function pauseProposalCleanup(stores, artifact) {
  const physical = stores.artifacts.physical;
  const remove = physical.remove.bind(physical);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  physical.remove = async (ref) => {
    if (ref.sha256 === artifact.sha256) {
      entered.resolve();
      await release.promise;
    }
    return remove(ref);
  };
  return {
    entered: entered.promise,
    release() {
      physical.remove = remove;
      release.resolve();
    },
  };
}

async function continueDuringDeletion(stores, work, deletion, cleanup) {
  const observed = Promise.withResolvers();
  const { coordination } = stores;
  const requireGate = coordination.requireGate.bind(coordination);
  coordination.requireGate = (gate, token) => {
    if (gate?.value.role === 'delete-proposal' && !token) observed.resolve(gate.value.role);
    requireGate(gate, token);
  };
  try {
    await Promise.race([cleanup.entered, deletion.then(() => assert.fail('Deletion skipped physical cleanup.'))]);
    const finished = finishUnrelatedWork(stores, work);
    const waitedFor = await Promise.race([
      observed.promise,
      finished.then(() => assert.fail('Unrelated write skipped the active cleanup seal.')),
    ]);
    cleanup.release();
    return { ...(await finished), waitedFor };
  } finally {
    coordination.requireGate = requireGate;
    cleanup.release();
  }
}

async function checkStaleConfirmation(page, service, proposal, remove) {
  const route = await fixtureRoute(page, '**/api/flow-action', async (request) => {
    if (request.request().postDataJSON()?.action === 'delete-pending-issue')
      await updateStoredIssueMetadata(service.root, proposal, { updated: '2026-11-27T07:00:00.000Z' });
    await request.continue();
  });
  try {
    page.once('dialog', (dialog) => void dialog.accept());
    await remove.click();
    const error = page.locator('#error-message');
    await error.waitFor();
    const diagnostic = await error.textContent();
    assert.match(diagnostic, /This proposal changed/);
    assert.equal(service.flows.selected(proposal.id).state, 'needs-approval');
    return diagnostic;
  } finally {
    await route();
  }
}

export async function proposalBrowserChecks({
  page,
  project,
  service,
  output,
  candidate,
  logs,
  clickAction,
  previous,
}) {
  await page.goto('/');
  const runs = logs.execution.length;
  const create = page.locator('#capture-dialog');
  await page.locator('#new-issue').click();
  assert.equal(await create.locator('#capture-retro').isChecked(), false);
  assert.equal(await create.locator('#capture-needs-approval').isChecked(), false);
  await create.locator('#capture-description').fill('Review an idle approval proposal');
  await create.locator('#capture-retro').check();
  await create.locator('#capture-needs-approval').check();
  await create.locator('#capture-submit').click();
  const approval = page.locator('#approve-issue');
  const remove = page.locator('#delete-pending-issue');
  await approval.waitFor();
  await remove.waitFor();
  await page.locator('#close-with-reason').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#worktree-menu').isVisible(), false);
  const approved = await clickAction(approval);
  await page.locator('#close-with-reason').waitFor();
  assert.equal(await approval.isVisible(), false);
  assert.equal(await remove.isVisible(), false);

  const title = 'Discard an idle retro proposal';
  await service.flows.fileRetroItems([
    {
      requestId: randomUUID(),
      title,
      description: 'An example recommendation from Retro.',
      reason: 'Exercise proposal deletion.',
      verification: 'Check the report file is gone.',
    },
  ]);
  const proposal = service.flows.issues().find((issue) => issue.title === title);
  assert.ok(proposal);
  assert.equal(service.flows.read(service.flows.selected(proposal.id)).folder, 'Retro items');
  const reportPath = join(project, '.issues', proposal.id + '.md');
  assert.equal(existsSync(reportPath), true);
  const row = page.locator(`#open-issues [data-issue="${proposal.id}"]`);
  await page.goto(new URL('/?issue=' + proposal.id, page.url()).href);
  await row.waitFor();
  const canceled = page.waitForEvent('dialog');
  const cancelClick = remove.click();
  const confirmation = await canceled;
  assert.match(confirmation.message(), /Permanently delete .*Discard an idle retro proposal/);
  await confirmation.dismiss();
  await cancelClick;
  assert.equal(existsSync(reportPath), true);
  const staleConfirmation = await checkStaleConfirmation(page, service, service.flows.selected(proposal.id), remove);
  await page.reload();
  await remove.waitFor();
  const before = service.flows.issues().map(({ id }) => id);
  const work = await beginUnrelatedWork(service, approved.issue.id, proposal.id);
  let delayedDelete = Promise.resolve();
  const delayDelete = (route) => {
    if (route.request().postDataJSON()?.action !== 'delete-pending-issue') return route.continue();
    delayedDelete = new Promise((done) => setTimeout(done, 16000)).then(() => route.continue());
    return delayedDelete;
  };
  const removeDelete = process.argv.includes('--delayed-delete')
    ? await fixtureRoute(page, '**/api/flow-action', delayDelete)
    : undefined;
  const cleanup = pauseProposalCleanup(service.projectStores, work.only);
  page.once('dialog', (dialog) => void dialog.accept());
  const deletion = clickAction(remove);
  let unrelated;
  try {
    [unrelated] = await Promise.all([continueDuringDeletion(service.projectStores, work, deletion, cleanup), deletion]);
  } finally {
    await delayedDelete;
    await removeDelete?.();
  }
  await row.waitFor({ state: 'detached' });
  assert.equal(new URL(page.url()).searchParams.has('issue'), false);
  assert.equal(existsSync(reportPath), false);
  assert.equal(existsSync(join(project, '.issues/closed', proposal.id + '.md')), false);
  assert.deepEqual(
    service.flows
      .issues()
      .map(({ id }) => id)
      .sort(),
    before.filter((id) => id !== proposal.id).sort()
  );
  const sharedBody = await checkRemovedEvidence(service.projectStores, proposal.id, work);
  assert.equal(logs.execution.length, runs);
  writeFileSync(
    join(output, 'proposal-deletion.json'),
    JSON.stringify(
      {
        candidate,
        proposal: proposal.id,
        canceled: true,
        staleConfirmation,
        deleted: true,
        enteredClosed: false,
        otherIssuesPreserved: true,
        pendingOperationPreserved: work.pending.value.id,
        sharedBody,
        exclusiveEvidenceRemoved: true,
        unrelated,
      },
      null,
      2
    )
  );
  await page.goto(previous ? '/?issue=' + previous : '/');
}
