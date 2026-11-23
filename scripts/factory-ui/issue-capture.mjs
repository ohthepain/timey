import { readClarificationSkills } from './project-discuss.mjs';
import { defaultIssueFolder, initializeFolderSettings, requireIssueFolder } from './issue-folder-settings.mjs';
import { storedIssuePath } from './issue-report-storage.mjs';
import { formatIssueReport, originalRequestSection } from './issue-report-format.mjs';
import { readModelSettings, saveIssueModelSettings } from './model-settings.mjs';
import { clarificationLifecycle } from './clarify-policy.mjs';
import { startCaptureGrilling } from './capture-grilling.mjs';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { assessCapture, captureAssessment } from './capture-assessment.mjs';
import { captureRoute, validateCaptureLifecycle, captureLifecycle } from './capture-routing.mjs';
import { readQueue } from './data.mjs';
import { queueIssueNumbers } from './issue-numbers.mjs';
import { digest, requireThat, writeJson } from './common.mjs';
import { resolveIssueStorage } from './stores/settings.mjs';
import { ensureProjectStores } from './stores/runtime.mjs';
import { newFlow } from './flow-store.mjs';
import { flowTarget } from './flow-observer.mjs';

const requestSchema = z
  .object({
    requestId: z.uuid(),
    folder: z.string().trim().min(1).max(4096).optional(),
    storageProfile: z.string().min(1).max(100).optional(),
    description: z.string().min(1).max(24000),
    grill: z.boolean().default(false),
    grillSkill: z.string().min(1).max(128).optional(),
    go: z.boolean().default(false),
    strategy: z.enum(['full-stop', 'full-send']).default('full-stop'),
    model: z.string().optional(),
  })
  .strict();
const receiptSchema = z
  .object({
    version: z.literal(1),
    requestId: z.uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    basis: z.string().regex(/^[a-f0-9]{64}$/),
    complete: z.boolean(),
    storage: z
      .object({
        profileId: z.string(),
        storeId: z.string(),
        artifactStoreId: z.string(),
      })
      .strict()
      .optional(),
    reports: z
      .array(
        z
          .object({
            id: z.string().regex(/^\d{8}T\d{9}-[a-f0-9]{16}$/),
            title: z.string().min(1).max(160),
            state: z.string().min(1),
            content: z.string().min(1).max(65536),
          })
          .strict()
      )
      .min(1)
      .max(12),
  })
  .strict();
const endpoint = '/api/issue-capture';
async function captureStorage(service, input) {
  if (service.projectStores) {
    requireThat(input.storageProfile, 'Choose an Issue storage profile before creating the issue.');
    await ensureProjectStores(service, { fresh: true });
  }
  if (!input.storageProfile) return undefined;
  const { profileId, storeId, artifactStoreId } = resolveIssueStorage(service.root, {
    profileId: input.storageProfile,
    folder: input.folder,
  });
  return { profileId, storeId, artifactStoreId };
}

export function createCaptures(service, options = {}) {
  const tasks = new Map();
  let persistence = Promise.resolve();
  const assess = options.assess || ((description, lifecycle) => assessCapture(description, lifecycle, service.root));
  const random = options.random || (() => randomBytes(8).toString('hex'));
  const publish = options.publish || publishExclusive;
  function guard() {
    requireThat(
      service.reviewMode !== 'preview' && !service.deploymentDraining,
      'Capture is unavailable in a preview or during deployment.'
    );
    service.serverControl?.allow(endpoint);
    service.ownServer();
  }
  async function save(value) {
    const input = requestSchema.parse(value);
    requireThat(input.description.trim(), 'Description is required.');
    guard();
    requireThat(
      !existsSync(join(service.root, '.issues/factory.lock')),
      'Queue lock exists. Wait for its owner before creating an issue.'
    );
    initializeFolderSettings(service.root);
    input.folder ||= defaultIssueFolder(service.root).name;
    requireIssueFolder(service.root, input.folder);
    input.storage = await captureStorage(service, input);
    validateModel(service.root, input.model);
    validateGrillingSkill(service.root, input);
    const pending = tasks.get(input.requestId);
    if (pending) {
      requireThat(
        pending.identity === captureIdentity(input),
        'This submission identity belongs to another description.'
      );
      return pending.promise;
    }
    const promise = perform(input)
      .then(async (result) => {
        if (service.sharedIssues)
          for (const issue of result.issues) {
            const saved = service.sharedIssues.checkpoint(issue.id, 'Issue created');
            issue.publication = { status: saved.status, url: saved.url, error: saved.error };
          }
        if (input.model && !service.projectStores)
          for (const issue of result.issues)
            await saveIssueModelSettings(service, { issueId: issue.id, model: input.model, effort: '' });
        return result;
      })
      .then((result) => (input.grill ? startCaptureGrilling(service, input, result) : result))
      .finally(() => tasks.delete(input.requestId));
    tasks.set(input.requestId, { identity: captureIdentity(input), promise });
    return promise;
  }
  async function perform(input) {
    const directory = join(service.root, '.issues/factory-ui/captures');
    const file = join(directory, input.requestId + '.json');
    const hash = captureHash(input);
    const previous = readReceipt(file, hash);
    if (previous?.complete) return response(previous, service.root);
    const before = captureQueue(service.root);
    validateCaptureLifecycle(before.lifecycle);
    const basis = policyBasis(service.root);
    const assessment = previous ? null : captureAssessment.parse(await assess(input.description, before.lifecycle));
    guard();
    const publishReceipt = () =>
      locked(service.root, () => {
        const receipt = readReceipt(file, hash);
        if (receipt?.complete) return response(receipt, service.root);
        requireThat(
          policyBasis(service.root) === (receipt?.basis || basis),
          'Capture policy changed. Restore it or submit a new draft after reviewing the change.'
        );
        const queue = captureQueue(service.root);
        const saved = receipt || allocate(queue, input, assessment, basis, random);
        mkdirSync(directory, { recursive: true });
        if (!receipt) writeJson(file, saved);
        const finish = () => {
          saved.complete = true;
          writeJson(file, saved);
          return response(saved, service.root);
        };
        if (service.projectStores) return publishCanonical(saved, input).then(finish);
        for (const report of saved.reports) {
          const path = join(service.root, '.issues', report.id + '.md');
          if (existsSync(path)) {
            requireThat(
              readFileSync(path, 'utf8') === report.content,
              `Capture ${report.id} already exists with changed contents. Preserve it and reconcile this submission.`
            );
          } else publish(path, report.content);
        }
        return finish();
      });
    if (!service.projectStores) return publishReceipt();
    const queued = persistence.then(publishReceipt, publishReceipt);
    persistence = queued.catch(() => {});
    return queued;
  }
  async function publishCanonical(saved, input) {
    for (const report of saved.reports) {
      const flow = newFlow({ ...report, content: report.content, folder: input.folder }, flowTarget(service.root));
      if (input.model) flow.settings = { model: input.model, effort: 'default' };
      await service.projectStores.createIssue({
        issueId: report.id,
        report: report.content,
        location: 'open',
        storeId: saved.storage.storeId,
        artifactStoreId: saved.storage.artifactStoreId,
        profileId: saved.storage.profileId,
        operationId: 'classic-capture/' + input.requestId + '/' + report.id,
        flow,
      });
    }
    await service.projectStores.refresh();
  }
  return {
    save,
    get active() {
      return tasks.size;
    },
  };
}
function readReceipt(file, hash) {
  if (!existsSync(file)) return null;
  const receipt = receiptSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  requireThat(
    receipt.version === 1 && receipt.hash === hash,
    'This submission identity belongs to another description.'
  );
  return receipt;
}
function policyBasis(root) {
  return digest(
    ['triage-labels.md', 'preferences.json']
      .map((name) => readFileSync(join(root, '.issues', name), 'utf8'))
      .join('\0') +
      (existsSync(join(root, 'factory.config.json')) ? readFileSync(join(root, 'factory.config.json'), 'utf8') : '')
  );
}
function locked(root, operation) {
  const lock = join(root, '.issues/factory.lock');
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error('Queue lock exists. Retry after its owner finishes; uncertain locks need reconciliation.');
    throw error;
  }
  const release = () => rmSync(lock, { recursive: true });
  let result;
  try {
    result = operation();
  } catch (error) {
    release();
    throw error;
  }
  if (result instanceof Promise) return result.finally(release);
  release();
  return result;
}
function allocate(queue, input, assessment, basis, random) {
  const at = new Date().toISOString(),
    ids = new Set();
  const reports = assessment.issues.map((proposal) => {
    requireThat(
      input.description.includes(proposal.excerpt),
      'The assessment did not preserve an exact original excerpt.'
    );
    const route = captureRoute(
      queue.lifecycle,
      input.grill ? { ...proposal, initialRole: 'ready-for-grilling', skips: [] } : proposal
    );
    const id = allocateId(queue.root, at, ids, random);
    const evidence = [{ path: join(queue.root, '.issues', id + '.md') }];
    const metadata = {
      id,
      title: proposal.title,
      state: route.state,
      created: at,
      updated: at,
      grill_later: false,
      autonomy: 'ask',
      folder_id: requireIssueFolder(queue.root, input.folder).id,
      category: proposal.category,
      capture_intent: {
        grill: input.grill,
        go: input.go,
        strategy: input.strategy,
        ...(input.grillSkill ? { grillSkill: input.grillSkill } : {}),
      },
      lifecycle_history: route.skipped.map((s) => ({
        ...s,
        outcome: 'skipped',
        next: route.state,
        at,
        source: { kind: 'original-report' },
        evidence,
      })),
    };
    const content =
      '---\n' +
      stringify(metadata, { aliasDuplicateObjects: false }) +
      '---\n\n' +
      originalRequestSection(input.description) +
      '\n\n## Relevant original wording\n\n' +
      proposal.excerpt +
      '\n\n## Routing\n\n' +
      proposal.reason +
      '\n\nReproduction: ' +
      proposal.reproduction +
      '. Capturing saves issues before starting any selected follow-up action.\n\n## Verification intent\n\n' +
      proposal.verification +
      '\n';
    return { id, title: proposal.title, state: route.state, content: formatIssueReport(content) };
  });
  return {
    version: 1,
    requestId: input.requestId,
    hash: captureHash(input),
    basis,
    reports,
    complete: false,
    ...(input.storage && { storage: input.storage }),
  };
}
function allocateId(root, at, ids, random) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = random();
    requireThat(/^[a-f0-9]{16}$/.test(suffix), 'Invalid capture identifier source.');
    const id = at.replace(/[-:.Z]/g, '') + '-' + suffix;
    if (
      ids.has(id) ||
      ['open', 'closed', 'archive'].some((location) => existsSync(storedIssuePath(root, id, location)))
    )
      continue;
    ids.add(id);
    return id;
  }
  throw Error('Could not allocate a unique capture ID. Retry this submission.');
}
function publishExclusive(path, content) {
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, path);
  } finally {
    unlinkSync(temp);
  }
}
function response(receipt, root) {
  const numbers = queueIssueNumbers(
    root,
    receipt.reports.map((report) => report.id)
  );
  return {
    requestId: receipt.requestId,
    issues: receipt.reports.map(({ id, title, state }) => ({ id, title, state, issueNumber: numbers[id] })),
  };
}

function captureQueue(root) {
  const queue = readQueue(root);
  queue.lifecycle = clarificationLifecycle(root, captureLifecycle(root)).stages;
  return queue;
}

function captureHash(input) {
  return digest(captureIdentity(input));
}

function captureIdentity(input) {
  return JSON.stringify([
    input.description,
    input.folder,
    ...(input.storageProfile ? [{ storageProfile: input.storageProfile, storage: input.storage }] : []),
    input.grill,
    input.go,
    input.strategy,
    input.model || null,
    ...(input.grillSkill ? [input.grillSkill] : []),
  ]);
}

function validateModel(root, model) {
  requireThat(
    !model || readModelSettings(root).models.some((item) => item.id === model),
    'Choose one of the listed models.'
  );
}

function validateGrillingSkill(root, input) {
  if (!input.grill || !input.grillSkill) return;
  requireThat(
    readClarificationSkills(root).some((item) => item.kind === 'skill' && item.skill === input.grillSkill),
    'Choose a configured grilling skill.'
  );
}
