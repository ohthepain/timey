import { validIdentity, storeFailure } from './coordination.mjs';
import { readSnapshot } from './snapshots.mjs';
import { registeredProjectStores } from './report-access.mjs';
import { mergedDelivery } from '../merged-issue.mjs';

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
