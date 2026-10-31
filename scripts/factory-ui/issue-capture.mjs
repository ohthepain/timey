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
import { digest, requireThat, writeJson } from './common.mjs';

const requestSchema = z
  .object({ requestId: z.uuid(), description: z.string().min(1).max(24000), grill: z.boolean().default(false) })
  .strict();
const receiptSchema = z
  .object({
    version: z.literal(1),
    requestId: z.uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    basis: z.string().regex(/^[a-f0-9]{64}$/),
    complete: z.boolean(),
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
export function createCaptures(service, options = {}) {
  const tasks = new Map();
  const assess = options.assess || assessCapture;
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
    const pending = tasks.get(input.requestId);
    if (pending) {
      requireThat(
        pending.description === input.description && pending.grill === input.grill,
        'This submission identity belongs to another description.'
      );
      return pending.promise;
    }
    const promise = perform(input)
      .then((result) => (input.grill ? startCaptureGrilling(service, input, result) : result))
      .finally(() => tasks.delete(input.requestId));
    tasks.set(input.requestId, { description: input.description, grill: input.grill, promise });
    return promise;
  }
  async function perform(input) {
    const directory = join(service.root, '.issues/factory-ui/captures');
    const file = join(directory, input.requestId + '.json');
    const hash = captureHash(input);
    const previous = readReceipt(file, hash);
    if (previous?.complete) return response(previous);
    const before = captureQueue(service.root);
    validateCaptureLifecycle(before.lifecycle);
    const basis = policyBasis(service.root);
    const assessment = previous ? null : captureAssessment.parse(await assess(input.description, before.lifecycle));
    guard();
    return locked(service.root, () => {
      const receipt = readReceipt(file, hash);
      if (receipt?.complete) return response(receipt);
      requireThat(
        policyBasis(service.root) === (receipt?.basis || basis),
        'Capture policy changed. Restore it or submit a new draft after reviewing the change.'
      );
      const queue = captureQueue(service.root);
      const saved = receipt || allocate(queue, input, assessment, basis, random);
      mkdirSync(directory, { recursive: true });
      if (!receipt) writeJson(file, saved);
      for (const report of saved.reports) {
        const path = join(service.root, '.issues', report.id + '.md');
        if (existsSync(path)) {
          requireThat(
            readFileSync(path, 'utf8') === report.content,
            `Capture ${report.id} already exists with changed contents. Preserve it and reconcile this submission.`
          );
        } else publish(path, report.content);
      }
      saved.complete = true;
      writeJson(file, saved);
      return response(saved);
    });
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
  try {
    return operation();
  } finally {
    rmSync(lock, { recursive: true });
  }
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
      category: proposal.category,
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
      '---\n\n## Original request\n\n' +
      input.description +
      '\n\n## Relevant original wording\n\n' +
      proposal.excerpt +
      '\n\n## Routing\n\n' +
      proposal.reason +
      '\n\nReproduction: ' +
      proposal.reproduction +
      '. Saving captures only; no work was started.\n\n## Verification intent\n\n' +
      proposal.verification +
      '\n';
    return { id, title: proposal.title, state: route.state, content };
  });
  return { version: 1, requestId: input.requestId, hash: captureHash(input), basis, reports, complete: false };
}
function allocateId(root, at, ids, random) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = random();
    requireThat(/^[a-f0-9]{16}$/.test(suffix), 'Invalid capture identifier source.');
    const id = at.replace(/[-:.Z]/g, '') + '-' + suffix;
    if (ids.has(id) || existsSync(join(root, '.issues', id + '.md'))) continue;
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
function response(receipt) {
  return {
    requestId: receipt.requestId,
    issues: receipt.reports.map(({ id, title, state }) => ({ id, title, state })),
  };
}

function captureQueue(root) {
  const queue = readQueue(root);
  queue.lifecycle = clarificationLifecycle(root, captureLifecycle(root)).stages;
  return queue;
}

function captureHash(input) {
  return digest(input.grill ? JSON.stringify([input.description, true]) : input.description);
}
