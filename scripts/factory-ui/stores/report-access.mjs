import { randomUUID, createHash } from 'node:crypto';
import {
  lstatSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { requireThat } from '../common.mjs';
import { requireUnmergedIssue, mergedIssueMessage } from '../merged-issue.mjs';
import { inputDigest } from './coordination.mjs';

const projects = new Map();

export function registerProjectStores(root, stores, { ownerForIssue, mergedForIssue } = {}) {
  const key = resolve(root);
  const registration = { stores, ownerForIssue, mergedForIssue };
  projects.set(key, registration);
  return () => {
    if (projects.get(key) === registration) projects.delete(key);
  };
}

export function registeredProjectStores(root) {
  return projects.get(resolve(root))?.stores || null;
}

export function afterReportWrite(write, confirmed, { onFailure, onSettled } = {}) {
  if (write instanceof Promise) {
    const result = write.then(confirmed);
    return (onFailure ? result.catch(onFailure) : result).finally(() => onSettled?.());
  }
  try {
    return confirmed(write);
  } catch (error) {
    if (onFailure) return onFailure(error);
    throw error;
  } finally {
    onSettled?.();
  }
}

function reportBytes(report) {
  return Buffer.isBuffer(report) ? report : Buffer.from(report);
}

function publicationFailure(message, code = 'STORE_OPERATION_MISMATCH') {
  return Object.assign(Error(message), { code });
}

function publicationPath(root, operationId) {
  const directories = ['.issues', '.issues/store-runtime', '.issues/store-runtime/report-writes'];
  for (const name of directories) {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    requireThat(lstatSync(directory).isDirectory(), 'Publication intents require real directories.');
  }
  return join(root, directories[2], inputDigest(operationId) + '.json');
}

function readPublication(path, digest) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = fstatSync(descriptor);
    requireThat(details.isFile() && !(details.mode & 0o077), 'Publication intents require owner-only regular files.');
    const intent = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (intent.version !== 1 || intent.inputDigest !== digest)
      throw publicationFailure('This report operation already names different input.');
    return intent;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'STORE_OPERATION_MISMATCH') throw error;
    throw publicationFailure(
      'The retained report publication intent needs reconciliation.',
      'STORE_PUBLICATION_CORRUPT'
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function retainPublication(path, intent, create = false) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporary, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (create) {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } else renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return readPublication(path, intent.inputDigest);
}

function reportOperationInput(issue, report, location, purpose, projectId) {
  return {
    projectId,
    issueId: issue.id,
    expectedReport: inputDigest(reportBytes(issue.content).toString('base64')),
    report: reportBytes(report).toString('utf8'),
    location,
    purpose,
  };
}

function validatePublication(intent, payload, operationId) {
  if (!intent) return;
  const request = intent.request;
  const allowed = new Set(['issueId', 'expectedRevision', 'report', 'location', 'purpose', 'owner']);
  requireThat(
    request && Object.keys(request).every((key) => allowed.has(key)) && typeof request.expectedRevision === 'string',
    'The publication intent is malformed.'
  );
  const requested = {
    issueId: payload.issueId,
    report: payload.report,
    location: payload.location,
    purpose: payload.purpose,
  };
  const recorded = {
    issueId: request.issueId,
    report: request.report,
    location: request.location,
    purpose: request.purpose,
  };
  if (
    intent.operationId !== operationId ||
    !['pending', 'confirmed'].includes(intent.status) ||
    inputDigest(requested) !== inputDigest(recorded)
  )
    throw publicationFailure('The retained publication intent belongs to different report input.');
}

async function matchOriginalReport(stores, operation, payload, intent) {
  if (intent || operation?.value.status !== 'confirmed') return;
  const revision = operation.value.input.expectedRevision;
  const original = (await stores.history(payload.issueId)).find((entry) => entry.revision === revision);
  if (!original || inputDigest(reportBytes(original.report).toString('base64')) !== payload.expectedReport)
    throw publicationFailure('The confirmed operation names a different original report.');
}

function matchConfirmedPublication(operation, payload, intent) {
  if (!operation || operation.value.status !== 'confirmed') return false;
  const saved = operation.value;
  const input = saved.input;
  const kind = payload.purpose === 'closure' ? 'close' : payload.purpose === 'storage' ? 'storage' : 'edit';
  const requested = { issueId: payload.issueId, report: payload.report, location: payload.location, kind };
  const recorded = { issueId: input.issueId, report: input.report, location: input.location, kind: input.kind };
  if (saved.kind !== 'save-issue' || input.flow !== undefined || inputDigest(requested) !== inputDigest(recorded))
    throw publicationFailure('The confirmed operation belongs to different report input.');
  if (
    intent &&
    (input.expectedRevision !== intent.request.expectedRevision ||
      inputDigest(input.owner || null) !== inputDigest(intent.request.owner || null))
  )
    throw publicationFailure('The confirmed operation differs from its retained publication intent.');
  return true;
}

async function initialPublication(stores, root, issue, payload, operationId, path, digest) {
  if (!['closure', 'storage'].includes(payload.purpose)) requireUnmergedIssue(root, issue.id);
  const current = await stores.readIssue(issue.id);
  requireThat(
    reportBytes(current.report).equals(reportBytes(issue.content)),
    'The authoritative issue report changed. Refresh before saving.'
  );
  return retainPublication(
    path,
    {
      version: 1,
      status: 'pending',
      inputDigest: digest,
      operationId,
      request: {
        issueId: issue.id,
        expectedRevision: current.revision,
        report: payload.report,
        location: payload.location,
        purpose: payload.purpose,
        owner: projects.get(resolve(root))?.ownerForIssue?.(issue.id) || null,
      },
    },
    true
  );
}

function localCommit(root, issue, report, location) {
  requireThat(/^[\w-]+$/.test(issue.id), 'Choose a valid saved issue ID.');
  const directories = { open: '.issues', closed: '.issues/closed', archive: '.issues/archive' };
  requireThat(Object.hasOwn(directories, location), 'Choose a valid issue location.');
  const path = join(root, directories[location], issue.id + '.md');
  for (const directory of new Set([join(root, '.issues'), dirname(path)]))
    requireThat(lstatSync(directory).isDirectory(), 'The issue storage folder must be a real directory.');
  const lock = join(root, '.issues/factory.lock');
  mkdirSync(lock);
  const temporary = join(dirname(path), `.report-${randomUUID()}.tmp`);
  try {
    requireThat(lstatSync(path).isFile(), 'The issue report must be a regular file.');
    requireThat(
      readFileSync(path).equals(reportBytes(issue.content)),
      'The issue report changed. Refresh before saving.'
    );
    writeFileSync(temporary, reportBytes(report), { flag: 'wx', mode: 0o600 });
    const descriptor = openSync(temporary, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true });
  }
  return { status: 'confirmed', id: issue.id, report, location };
}

export async function commitStoredReport(
  root,
  issue,
  report,
  { location = issue.reportLocation || issue.location || 'open', purpose = 'edit', operationId } = {}
) {
  requireThat(issue && typeof issue.content === 'string', 'The expected issue report is required.');
  const stores = registeredProjectStores(root);
  if (!stores) {
    if (!['closure', 'storage'].includes(purpose)) {
      requireUnmergedIssue(root, issue.id);
      requireThat(!projects.get(resolve(root))?.mergedForIssue?.(issue.id), mergedIssueMessage);
    }
    return localCommit(root, issue, report, location);
  }
  const payload = reportOperationInput(issue, report, location, purpose, stores.projectId);
  const digest = inputDigest(payload);
  const id = operationId || 'report-' + digest;
  const path = publicationPath(root, id);
  let intent = readPublication(path, digest);
  validatePublication(intent, payload, id);
  const previous = await stores.coordination.get('operations/' + encodeURIComponent(id));
  await matchOriginalReport(stores, previous, payload, intent);
  if (matchConfirmedPublication(previous, payload, intent)) {
    if (intent) retainPublication(path, { ...intent, status: 'confirmed' });
    await stores.refresh({ issueIds: [issue.id] });
    return { status: 'confirmed', ...(await stores.readIssue(issue.id)) };
  }
  requireThat(intent?.status !== 'confirmed', 'The confirmed publication receipt needs reconciliation.');
  intent ||= await initialPublication(stores, root, issue, payload, id, path, digest);
  validatePublication(intent, payload, id);
  const result = await stores.saveIssue({ ...intent.request, operationId: id });
  requireThat(result.status === 'confirmed', 'The issue report is pending authoritative confirmation.');
  retainPublication(path, { ...intent, status: 'confirmed' });
  await stores.refresh({ issueIds: [issue.id] });
  return result;
}

export async function moveRegisteredReport(root, id, from, to, expectedContent) {
  const stores = registeredProjectStores(root);
  const current = await stores.readIssue(id);
  requireThat(current.location === from || current.location === to, 'The authoritative issue location changed.');
  const content = reportBytes(current.report).toString('utf8');
  requireThat(
    expectedContent === undefined || content === expectedContent,
    'The issue report changed before the move.'
  );
  return commitStoredReport(root, { id, content, location: from }, current.report, {
    location: to,
    purpose: 'storage',
  });
}

export async function deleteRegisteredReport(root, issue, purpose) {
  const stores = registeredProjectStores(root);
  const current = await stores.readIssue(issue.id);
  requireThat(
    reportBytes(current.report).equals(reportBytes(issue.content)),
    'The issue report changed before deletion.'
  );
  requireThat(typeof stores.deleteIssue === 'function', 'The selected store does not support checked issue deletion.');
  const result = await stores.deleteIssue({
    issueId: issue.id,
    expectedRevision: current.revision,
    operationId:
      'delete-report-' +
      createHash('sha256')
        .update(JSON.stringify([issue.id, current.revision, purpose]))
        .digest('hex'),
    purpose,
  });
  requireThat(result.status === 'confirmed', 'The issue deletion is pending authoritative confirmation.');
  await stores.refresh({ issueIds: [issue.id] });
  return result;
}
