import { validIdentity, storeFailure, sameOwner, inputDigest, assertStoreState } from './coordination.mjs';
import { readSnapshot } from './snapshots.mjs';
import { registeredProjectStores } from './report-access.mjs';
import { mergedDelivery } from '../merged-issue.mjs';
import { reconcileRecoveredProgress } from './recovered-flow.mjs';

const observed = new WeakMap();

function project(service) {
  const stores = service.projectStores || registeredProjectStores(service.root);
  if (!stores) throw storeFailure('STORE_UNCONFIGURED', 'Project storage is not initialized.');
  return stores;
}

function attemptIn(flow, attemptId) {
  return [...(flow?.blocks || []), ...(flow?.retiredBlocks || [])]
    .flatMap((block) => block.attempts || [])
    .find((attempt) => attempt.id === attemptId);
}

function ownershipView(service, issueId, { claim, flow, capturedAt }, authoritative) {
  const owner = claim?.value || claim;
  const merged = Boolean(flow && mergedDelivery(flow));
  const localActive = Boolean(service.flows?.active?.has(issueId));
  const attempt = owner && attemptIn(flow, owner.attemptId);
  return {
    issueId,
    authoritative,
    unavailable: !authoritative,
    capturedAt,
    ownership: owner
      ? {
          issueId,
          attemptId: owner.attemptId,
          runnerId: owner.runnerId,
          ownerToken: owner.token,
          acquiredAt: owner.acquiredAt,
          attemptStatus: attempt?.status,
        }
      : null,
    merged,
    canRestart: Boolean(authoritative && !merged && !owner),
    canRecover: Boolean(authoritative && owner && attempt && !localActive),
    confirmation: 'I confirmed that this runner stopped and its outstanding Git or API operations were reconciled.',
    ...(localActive && {
      reason: 'Stop this local attempt and wait for cancellation before recovering its ownership.',
    }),
    ...(owner &&
      !attempt && { reason: 'This claim belongs to pending publication. Reconcile its saved operation first.' }),
    ...(!authoritative && {
      reason: 'Cached ownership is read-only. Reconnect to authoritative storage before recovery.',
    }),
  };
}

function cachedOwnership(service, issueId) {
  const previous = observed.get(service)?.get(issueId);
  if (previous)
    return {
      ...previous,
      authoritative: false,
      unavailable: true,
      canRecover: false,
      canRestart: false,
      reason: 'Cached ownership is read-only. Reconnect to authoritative storage before recovery.',
    };
  let snapshot;
  try {
    snapshot = readSnapshot(service.root);
  } catch {
    snapshot = null;
  }
  const claim = snapshot?.claims?.find((owner) => owner.issueId === issueId);
  const flow = snapshot?.issues?.find((issue) => issue.id === issueId)?.flow;
  return ownershipView(service, issueId, { claim, flow, capturedAt: snapshot?.capturedAt }, false);
}

async function currentOwnership(stores, issueId) {
  const read = async (records) => {
    const [claim, flow] = await Promise.all([records.get('claims/' + issueId), records.get('flows/' + issueId)]);
    return { claim, flow: flow?.value, capturedAt: new Date().toISOString() };
  };
  return stores.records.readSnapshot ? stores.records.readSnapshot(read) : read(stores.records);
}

export async function readOwnership(service, { issueId }) {
  validIdentity(issueId);
  if (service.storeStatus?.unavailable) return cachedOwnership(service, issueId);
  try {
    await reconcileRecoveredProgress(service, project(service), issueId);
    const view = ownershipView(service, issueId, await currentOwnership(project(service), issueId), true);
    if (!observed.has(service)) observed.set(service, new Map());
    observed.get(service).set(issueId, view);
    return view;
  } catch (error) {
    if (error.code === 'STORE_UNCONFIGURED') throw error;
    return cachedOwnership(service, issueId);
  }
}

function recoveryInput(input) {
  for (const key of ['issueId', 'attemptId', 'runnerId', 'ownerToken']) validIdentity(input?.[key], key);
  if (
    input.confirmed !== true ||
    typeof input.reason !== 'string' ||
    input.reason.trim().length < 8 ||
    input.reason.length > 2000
  )
    throw storeFailure(
      'STORE_RECOVERY_CONFIRMATION',
      'Confirm the original runner stopped and describe how its outstanding operations were reconciled.'
    );
  if (typeof input.operationId !== 'string' || !/^[\w-]{1,120}$/.test(input.operationId))
    throw storeFailure('STORE_INVALID_OPERATION', 'Use a stable recovery operation identity.');
  return {
    issueId: input.issueId,
    attemptId: input.attemptId,
    runnerId: input.runnerId,
    ownerToken: input.ownerToken,
    reason: input.reason.trim(),
  };
}

function requireExactOwner(service, input, current) {
  const owner = current.claim?.value;
  if (
    !owner ||
    owner.token !== input.ownerToken ||
    owner.attemptId !== input.attemptId ||
    owner.runnerId !== input.runnerId
  )
    throw storeFailure(
      'STORE_NOT_OWNER',
      'The issue ownership changed. Refresh its exact attempt and runner before recovery.'
    );
  if (service.flows?.active?.has(input.issueId))
    throw storeFailure(
      'STORE_ACTIVE_RUN',
      'Stop this local attempt and wait for acknowledged cancellation before recovery.'
    );
  if (!attemptIn(current.flow, input.attemptId))
    throw storeFailure(
      'STORE_ATTEMPT_MISSING',
      'This claim belongs to publication rather than an attempt. Reconcile its pending operation first.'
    );
}

export async function recoverOwnership(service, input) {
  service.ownServer();
  const requested = recoveryInput(input);
  if (service.storeStatus?.unavailable)
    throw storeFailure('STORE_UNAVAILABLE', 'Reconnect to authoritative storage before recovering ownership.');
  const stores = project(service);
  const id = 'ownership-recovery-' + input.operationId;
  const prior = await stores.coordination.get('operations/' + encodeURIComponent(id));
  if (!prior) requireExactOwner(service, requested, await currentOwnership(stores, requested.issueId));
  if (prior?.value.status !== 'confirmed' && service.flows?.active?.has(requested.issueId))
    throw storeFailure('STORE_ACTIVE_RUN', 'Stop this local attempt before recovering its ownership.');
  await stores.recoverAttempt({ ...requested, operationId: id, confirmed: true });
  await stores.refresh({ issueIds: [requested.issueId] });
  return { ...(await readOwnership(service, requested)), recovered: true, recoveredAttemptId: requested.attemptId };
}

function publicationCancellation(input) {
  if (input.confirmed !== true || typeof input.reason !== 'string' || input.reason.trim().length < 8)
    throw storeFailure(
      'STORE_RECOVERY_CONFIRMATION',
      'Confirm the original publication stopped and record why it is being cancelled.'
    );
  validIdentity(input.issueId);
  validIdentity(input.operationId);
  if (
    typeof input.publicationId !== 'string' ||
    input.publicationId.length === 0 ||
    input.publicationId.length >= 500 ||
    input.reason.length > 2000 ||
    typeof input.operationRevision !== 'string' ||
    ![input.flowRevision, input.claimRevision].every((revision) => revision === null || typeof revision === 'string')
  )
    throw storeFailure(
      'STORE_INVALID_OPERATION',
      'Supply the exact bounded publication and observed record revisions.'
    );
  return {
    id: input.operationId,
    reason: input.reason.trim(),
    operationRevision: input.operationRevision,
    flowRevision: input.flowRevision,
    claimRevision: input.claimRevision,
  };
}

function requirePendingPublication(operation, input) {
  const value = operation?.value;
  if (
    value?.kind !== 'save-flow' ||
    value.status !== 'pending' ||
    value.input.issueId !== input.issueId ||
    value.input.owner ||
    operation.revision !== input.operationRevision
  )
    throw storeFailure(
      'STORE_CONFLICT',
      'The pending ownerless flow publication changed. Refresh before cancellation.'
    );
}

async function requirePublicationClaim(stores, operation, input) {
  const { claim, flow } = await currentOwnership(stores, input.issueId);
  const flowRecord = await stores.records.get('flows/' + input.issueId);
  if ((claim?.revision ?? null) !== input.claimRevision || (flowRecord?.revision ?? null) !== input.flowRevision)
    throw storeFailure('STORE_CONFLICT', 'The publication claim or flow changed. Refresh before cancellation.');
  if (claim && !sameOwner(claim.value, stores.coordination.owner(operation, input.issueId)))
    throw storeFailure('STORE_NOT_OWNER', 'Another operation owns this issue.');
  if (claim && attemptIn(flow, claim.value.attemptId))
    throw storeFailure('STORE_ACTIVE_RUN', 'This claim belongs to an execution attempt, not an unpublished flow save.');
  return claim;
}

export async function cancelPendingFlowSave(service, input) {
  service.ownServer();
  const recovery = publicationCancellation(input);
  const stores = project(service);
  const key = 'operations/' + encodeURIComponent(input.publicationId);
  const operation = await stores.records.get(key);
  const value = operation?.value;
  if (
    value?.status === 'rejected' &&
    value.errorCode === 'STORE_PUBLICATION_CANCELLED' &&
    inputDigest(value.recovery) === inputDigest(recovery)
  )
    return { cancelled: true };
  if (service.flows?.active?.has(input.issueId))
    throw storeFailure('STORE_ACTIVE_RUN', 'Stop the local publication before cancelling it.');
  requirePendingPublication(operation, input);
  const claim = await requirePublicationClaim(stores, operation, input);
  await stores.coordination.commit(
    'cancel-publication-' + input.operationId,
    [
      { key, revision: operation.revision },
      { key: 'flows/' + input.issueId, revision: input.flowRevision },
      { key: 'claims/' + input.issueId, revision: input.claimRevision },
    ],
    [
      {
        key,
        value: {
          ...value,
          status: 'rejected',
          errorCode: 'STORE_PUBLICATION_CANCELLED',
          error: 'The interrupted flow publication was explicitly cancelled.',
          rejectedAt: new Date().toISOString(),
          recovery,
        },
      },
      ...(claim ? [{ key: claim.key, value: null }] : []),
    ]
  );
  return { cancelled: true };
}

function requireOwnerBoundSave({ kind, status, input = {} } = {}) {
  assertStoreState(
    kind === 'save-flow' && status === 'pending' && input.owner,
    'STORE_CONFLICT',
    'Choose a pending flow save from a previously owned attempt.'
  );
}

function requireAdvancedFlow(flow, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || !(flow?.value.revision > expectedRevision))
    throw storeFailure('STORE_CONFLICT', 'The current flow must be newer than the pending save.');
}

async function supersededSaveConditions(service, coordination, { issueId, expectedRevision }) {
  validIdentity(issueId);
  const flowKey = 'flows/' + issueId;
  const claimKey = 'claims/' + issueId;
  const [flow, claim] = await Promise.all([coordination.get(flowKey), coordination.get(claimKey)]);
  assertStoreState(
    !claim && !service.flows?.active?.has(issueId),
    'STORE_BUSY',
    'Wait until the issue has no active work or shared claim.'
  );
  requireAdvancedFlow(flow, expectedRevision);
  return [
    { key: flowKey, revision: flow.revision },
    { key: claimKey, revision: null },
  ];
}

export async function reconcileSupersededFlowSave(service, { operationId }) {
  const { coordination } = project(service);
  const key = 'operations/' + encodeURIComponent(operationId);
  const operation = await coordination.get(key);
  const saved = operation?.value;
  if (saved?.errorCode === 'STORE_SUPERSEDED_FLOW_SAVE') return { reconciled: true };
  requireOwnerBoundSave(saved);
  const conditions = await supersededSaveConditions(service, coordination, saved.input);
  await coordination.commit(
    'reconcile-superseded-' + operationId,
    [{ key, revision: operation.revision }, ...conditions],
    [
      {
        key,
        value: {
          ...saved,
          status: 'rejected',
          errorCode: 'STORE_SUPERSEDED_FLOW_SAVE',
          error: 'The issue advanced and the originating claim was released.',
          rejectedAt: coordination.now(),
        },
      },
    ]
  );
  return { reconciled: true };
}
