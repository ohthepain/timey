import { FileReadCache } from './file-read-cache.mjs';
import { registeredProjectStores } from './stores/report-access.mjs';
import { sameOwner } from './stores/coordination.mjs';
import { blockDefinitionId, missingMergePR, requestBlock, withoutBlock } from './flow-block-data.mjs';
import { BlockCatalog } from './block-catalog.mjs';
import {
  blockDependencies,
  independentOutput,
  inquiryKinds,
  joinPendingLanes,
  reorderedBlocks,
} from './flow-order.mjs';
import { bundledFlow } from './flow-definitions.mjs';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, writeJson, digest } from './common.mjs';

export function requireIssueId(id) {
  requireThat(typeof id === 'string' && /^[\w-]{1,100}$/.test(id), 'Choose a valid saved issue.');
}
export function inferType(wording) {
  if (/\b(investigate|understand|explain|why does|research)\b/i.test(wording)) return 'investigation';
  return /\b(bug|broken|crash|fails?|error|regression|doesn't work)\b/i.test(wording) ? 'bug' : 'feature';
}
const bundledCatalog = new BlockCatalog();

export function makeBlock(kind, after = [], suggested = false, catalog = bundledCatalog.read().entries) {
  const entry = catalog.find((item) => item.id === kind);
  requireThat(entry, 'Choose a known block type.');
  return {
    id: randomUUID(),
    kind: entry.kind,
    ...(entry.id !== entry.kind ? { definition: entry.id } : {}),
    label: entry.label,
    skill: entry.defaultSkill,
    skillExplicit: false,
    prompt: '',
    iterations: 1,
    lane: 0,
    after,
    suggested,
    edits: [],
    comments: [],
    attempts: [],
    definitionChecksum: entry.checksum,
    declaredArtifacts: entry.artifacts,
    declaredDetails: entry.details,
  };
}
function originalWording(issue) {
  return (
    issue.content
      .match(/^## (?:Original request|Relevant original wording)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]
      ?.replace(/\n\n<!-- prettier-ignore-end -->\s*$/, '')
      ?.trim() || issue.title
  );
}
export function newFlow(issue, delivery, catalog = bundledCatalog.read().entries, selected) {
  const wording = originalWording(issue);
  const type = issue.request_type || inferType(wording);
  const definition = selected?.definition ?? bundledFlow(type);
  const blocks = (selected?.nodes ?? definition.blocks).map((node) => {
    const block = makeBlock(node.block, node.after, node.suggested, catalog);
    return { ...block, id: node.id, flowKey: node.id, lane: node.lane };
  });
  blocks[0].data = { wording, fields: null, ...(issue.run_retro && { runRetro: true }) };
  const flow = {
    version: 1,
    issueId: issue.id,
    revision: 0,
    routeType: type,
    target: delivery,
    startingPoint: null,
    folder: issue.folder || null,
    workspace: null,
    blocks,
  };
  linkFlowDefinition(flow, definition);
  return flow;
}

export function linkFlowDefinition(flow, { id, name, checksum }) {
  flow.definition = { id, name, checksum };
}

function migrateFlow(flow, defaultTarget) {
  const request = requestBlock(flow);
  request.flowKey = 'request';
  if (!request.data) {
    const { wording, proof, ...fields } = flow.request;
    request.data = { wording, fields: { ...fields, requestedProof: proof, type: flow.type } };
    flow.routeType = flow.type;
  }
  retireLegacyBlocks(flow);
  migrateUpdateBranch(flow);
  linkPreWorkUpdate(flow.blocks);
  flow.target ??= defaultTarget;
  flow.startingPoint ??= null;
  delete flow.request;
  delete flow.type;
  if (!flow.definition) {
    const definition = bundledFlow(flow.routeType);
    const kinds = new Map(definition.blocks.map((block) => [block.id, block.block]));
    for (const block of flow.blocks) {
      if (kinds.get(block.id) === blockDefinitionId(block) || block.routeDefault) {
        block.flowKey = block.routeDefault
          ? (definition.blocks.find((node) => node.block === blockDefinitionId(block))?.id ?? block.id)
          : block.id;
      }
    }
    linkFlowDefinition(flow, definition);
  }
  reconcileMergeAttempts(flow);
  return flow;
}

function retireLegacyBlocks(flow) {
  const target = flow.blocks.find((block) => block.kind === 'target');
  if (target) {
    flow.target ??= target.data?.delivery;
    flow.startingPoint ??= target.data?.startingPoint ?? null;
  }
  for (const block of flow.blocks.filter(({ kind }) => ['target', 'verify'].includes(kind)).reverse()) {
    flow.blocks = withoutBlock(flow.blocks, block);
    for (const remaining of flow.blocks)
      for (const key of Object.keys(remaining.links ?? {}))
        if (remaining.links[key] === block.id) delete remaining.links[key];
    if (block.attempts?.length || block.comments?.length) (flow.retiredBlocks ??= []).push(block);
  }
}

function reconcileMergeAttempts(flow) {
  const pr = flow.destination?.pr;
  const branch = flow.workspace?.branch;
  if (!pr || !branch) return;
  const publishedAt = flow.blocks
    .filter(({ kind }) => kind === 'publish')
    .flatMap(({ attempts }) => attempts)
    .filter(({ status, result, endedAt }) => status === 'completed' && result?.pr === pr && endedAt)
    .map(({ endedAt }) => endedAt)
    .sort()
    .at(-1);
  if (!publishedAt) return;
  const summary = missingMergePR(branch);
  for (const attempt of flow.blocks.filter(({ kind }) => kind === 'merge').flatMap(({ attempts }) => attempts)) {
    if (
      ['blocked', 'failed'].includes(attempt.status) &&
      attempt.summary === summary &&
      attempt.endedAt &&
      attempt.endedAt <= publishedAt
    ) {
      attempt.invalidatedAt ??= publishedAt;
      attempt.supersededByPR = pr;
    }
  }
}

function migrateUpdateBranch(flow) {
  for (const block of [...flow.blocks, ...(flow.retiredBlocks ?? [])]) {
    if (block.kind !== 'merge-target') continue;
    block.kind = 'update-branch';
    if (block.definition === 'merge-target') block.definition = 'update-branch';
    if (['Merge from target', 'Update branch'].includes(block.label)) block.label = 'Update Branch';
  }
}

function canRetainBlock(before, node) {
  if (!before) return false;
  return blockDefinitionId(before) === node.block || (inquiryKinds.has(before.kind) && node.block === 'investigate');
}
function routeBlock(before, node, catalog) {
  const block = canRetainBlock(before, node) ? { ...before } : makeBlock(node.block, [], node.suggested, catalog);
  if (block.kind === 'understand' && node.block === 'investigate') {
    const entry = catalog.find(({ id }) => id === 'investigate');
    Object.assign(block, {
      legacyKind: block.kind,
      kind: 'investigate',
      label: entry.label,
      definitionChecksum: entry.checksum,
      declaredDetails: entry.details,
      declaredArtifacts: entry.artifacts,
    });
    delete block.definition;
  }
  return block;
}
export function rebuildRoute(flow, type, definition, nodes, catalog) {
  const current = new Map(flow.blocks.filter((block) => block.flowKey).map((block) => [block.flowKey, block]));
  const taken = new Set([...flow.blocks, ...(flow.retiredBlocks ?? [])].map((block) => block.id));
  const ids = new Map();
  const retained = new Set();
  const blocks = nodes.map((node) => {
    const before = current.get(node.id);
    const block = routeBlock(before, node, catalog);
    if (before?.id === block.id) retained.add(block.id);
    else if (!taken.has(node.id)) block.id = node.id;
    taken.add(block.id);
    ids.set(node.id, block.id);
    return {
      ...block,
      flowKey: node.id,
      after: node.after.map((id) => ids.get(id)),
      lane: node.lane,
      suggested: !block.attempts.length && node.suggested,
    };
  });
  flow.retiredBlocks = [...(flow.retiredBlocks ?? []), ...flow.blocks.filter((block) => !retained.has(block.id))];
  flow.blocks = blocks;
  flow.routeType = type;
  linkFlowDefinition(flow, definition);
  return flow;
}

export class FlowStore {
  constructor(root, { ownerForIssue, onSaved } = {}) {
    this.root = root;
    this.ownerForIssue = ownerForIssue;
    this.onSaved = onSaved;
    this.staged = new Map();
    this.flushes = new Map();
    this.readCache = new FileReadCache((content) => JSON.parse(content));
    this.directory = join(root, '.issues/flows');
  }
  path(id) {
    requireIssueId(id);
    return join(this.directory, id, 'flow.json');
  }
  read(issue, target, catalog) {
    const pending = this.pendingFlow(issue.id);
    if (pending) return structuredClone(pending.flow);
    const path = this.path(issue.id);
    if (!existsSync(path)) {
      this.readCache.forget(path);
      return newFlow(issue, target, catalog);
    }
    const record = this.readCache.read(path);
    requireThat(
      record.version === 1 && record.issueId === issue.id && Array.isArray(record.blocks),
      'The saved flow needs reconciliation. It was not reset.'
    );
    return migrateFlow(record, target);
  }
  save(flow, expectedRevision) {
    const stores = registeredProjectStores(this.root);
    if (stores) return this.saveAuthoritative(stores, flow, expectedRevision);
    return this.saveLocal(flow, expectedRevision);
  }
  async saveAuthoritative(stores, flow, expectedRevision, owner = this.ownerForIssue?.(flow.issueId)) {
    validateGraph(flow.blocks);
    reconcileMergeAttempts(flow);
    const saved = await stores.saveFlow({
      issueId: flow.issueId,
      flow,
      expectedRevision,
      operationId: 'flow-' + digest(JSON.stringify([flow, expectedRevision])),
      owner,
      purpose: flow.closing ? 'closure' : 'edit',
    });
    mkdirSync(join(this.directory, flow.issueId), { recursive: true });
    writeJson(this.path(flow.issueId), saved);
    this.onSaved?.(flow.issueId);
    return saved;
  }
  stage(flow, expectedRevision) {
    if (!registeredProjectStores(this.root)) return this.saveLocal(flow, expectedRevision);
    validateGraph(flow.blocks);
    const previous = this.staged.get(flow.issueId);
    const pending = {
      flow: structuredClone(flow),
      generation: (previous?.generation || 0) + 1,
      owner: this.ownerForIssue?.(flow.issueId),
    };
    this.staged.set(flow.issueId, pending);
    this.writePending(flow.issueId, pending);
    return flow;
  }
  async flush(issueId, { drain = true } = {}) {
    let saved;
    do {
      let task = this.flushes.get(issueId);
      if (!task) {
        task = this.flushStaged(issueId).finally(() => this.flushes.delete(issueId));
        this.flushes.set(issueId, task);
      }
      saved = await task;
    } while (drain && this.staged.has(issueId));
    return saved;
  }
  async flushStaged(issueId) {
    const publication = this.flowPublication(issueId);
    if (!publication) return;
    const saved = await this.saveAuthoritative(
      registeredProjectStores(this.root),
      publication.flow,
      publication.flow.revision,
      publication.owner
    );
    const current = this.staged.get(issueId);
    if (current?.generation === publication.generation) {
      this.staged.delete(issueId);
      const path = join(this.root, '.issues/store-runtime/pending-flows', issueId + '.json');
      if (existsSync(path)) unlinkSync(path);
    } else if (current) {
      current.flow.revision = saved.revision;
      this.writePending(issueId, current);
    }
    unlinkSync(this.publicationPath(issueId));
    return saved;
  }
  publicationPath(issueId) {
    return join(this.root, '.issues/store-runtime/flow-publications', issueId + '.json');
  }
  flowPublication(issueId) {
    this.pendingFlow(issueId);
    const path = this.publicationPath(issueId);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    const pending = this.staged.get(issueId);
    if (!pending) return null;
    mkdirSync(join(this.root, '.issues/store-runtime/flow-publications'), { recursive: true });
    writeJson(path, pending);
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  pendingFlow(issueId) {
    const path = join(this.root, '.issues/store-runtime/pending-flows', issueId + '.json');
    if (!this.staged.has(issueId) && existsSync(path)) {
      const pending = JSON.parse(readFileSync(path, 'utf8'));
      requireThat(pending.flow?.issueId === issueId, 'The pending flow needs reconciliation.');
      this.staged.set(issueId, pending);
    }
    return this.staged.get(issueId);
  }
  writePending(issueId, pending) {
    const directory = join(this.root, '.issues/store-runtime/pending-flows');
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, issueId + '.json'), pending);
  }
  saveLocal(flow, expectedRevision) {
    const path = this.path(flow.issueId);
    const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).revision : 0;
    requireThat(current === expectedRevision, 'This flow changed. Refresh before saving this edit.');
    validateGraph(flow.blocks);
    reconcileMergeAttempts(flow);
    const saved = { ...flow, revision: current + 1, updatedAt: new Date().toISOString() };
    mkdirSync(join(this.directory, flow.issueId), { recursive: true });
    writeJson(path, saved);
    this.onSaved?.(flow.issueId);
    return saved;
  }
}
export function retireRecoveredPending(store, owner, recovery) {
  const issueId = owner.issueId;
  requireIssueId(issueId);
  const pending = store.pendingFlow(issueId);
  if (store.flushes.has(issueId) || !sameOwner(pending?.owner, owner)) return;
  const publicationPath = store.publicationPath(issueId);
  const publication = existsSync(publicationPath) ? JSON.parse(readFileSync(publicationPath, 'utf8')) : null;
  if (publication && !sameOwner(publication.owner, owner)) return;
  const evidence = { pending, publication, recovery };
  const directory = join(store.root, '.issues/store-runtime/recovered-flows', issueId);
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, digest(JSON.stringify(evidence)) + '.json'), evidence);
  if (publication) unlinkSync(publicationPath);
  unlinkSync(join(store.root, '.issues/store-runtime/pending-flows', issueId + '.json'));
  store.staged.delete(issueId);
}
function validateGraph(blocks) {
  requireThat(blocks.length <= 200, 'Keep each issue flow under 200 blocks.');
  const seen = new Set();
  for (const block of blocks) {
    requireThat(
      !seen.has(block.id) && block.after.every((id) => seen.has(id)),
      'Block dependencies must precede the block.'
    );
    seen.add(block.id);
  }
}
function updateBranchIndex(blocks) {
  const work = blocks.findIndex(isWorkBlock);
  return work >= 0 ? work : blocks.findIndex((block) => block.suggested);
}

export function insertSuggestedTargetUpdate(flow, update) {
  const at = updateBranchIndex(flow.blocks);
  const index = at < 0 ? flow.blocks.length : at;
  const next = flow.blocks[index];
  if (next && isWorkBlock(next)) {
    update.lane = next.lane;
    update.after = [...next.after];
    next.after = [update.id];
  } else {
    update.after = flow.blocks
      .slice(0, index)
      .slice(-1)
      .map((block) => block.id);
  }
  flow.blocks.splice(index, 0, update);
}

export function editFlow(flow, input, catalog) {
  const next = structuredClone(flow);
  const block = next.blocks.find((item) => item.id === input.blockId);
  const actions = {
    folder() {
      next.folder = folderName(input.folder);
    },
    add() {
      const explicit = input.afterId ? next.blocks.findIndex((item) => item.id === input.afterId) : -1;
      requireThat(!input.afterId || explicit >= 0, 'Choose an existing insertion point.');
      const index = explicit >= 0 ? explicit + 1 : defaultInsertionIndex(next.blocks, input.kind);
      const at = index < 0 ? next.blocks.length : Math.max(1, index);
      requireThat(
        !['request', 'target'].includes(input.kind),
        'Add a block other than Request or the legacy Target block.'
      );
      const added = makeBlock(input.kind, at ? [next.blocks[at - 1].id] : [], false, catalog);
      requireThat(added.kind !== 'verify', 'Run tests in Work or Merge.');
      added.lane = validLane(input.lane ?? (input.kind === 'update-branch' ? next.blocks[at]?.lane : 0) ?? 0);
      added.after = blockDependencies(next, added, at);
      next.blocks.splice(at, 0, added);
      const following = next.blocks[at + 1];
      if (input.kind === 'update-branch') linkPreWorkUpdate(next.blocks);
      else if (
        following &&
        !following.attempts.length &&
        following.lane === added.lane &&
        !independentOutput(next, following)
      )
        following.after = [added.id];
    },
    update() {
      requireEditable(block);
      const values = input.changes;
      requireThat(values && typeof values === 'object', 'Supply block edits.');
      for (const key of Object.keys(values))
        requireThat(
          ['label', 'skill', 'prompt', 'iterations', 'lane', 'edits', 'inputs', 'links', 'model'].includes(key),
          'Unknown block edit.'
        );
      if ('label' in values)
        requireThat(
          typeof values.label === 'string' && values.label.trim() && values.label.length <= 160,
          'Use a block label under 160 characters.'
        );
      if ('skill' in values)
        requireThat(
          values.skill === null ||
            (typeof values.skill === 'string' &&
              /^[\w.:-]{1,160}$/.test(values.skill) &&
              catalog.find((entry) => entry.id === blockDefinitionId(block))?.skills?.includes(values.skill)),
          'Choose a valid installed skill.'
        );
      if ('skill' in values) block.skillExplicit = true;
      if ('prompt' in values)
        requireThat(
          typeof values.prompt === 'string' && values.prompt.length <= 12000,
          'Use an instruction under 12,000 characters.'
        );
      if ('iterations' in values)
        requireThat(
          Number.isInteger(values.iterations) && values.iterations >= 1 && values.iterations <= 10,
          'Choose one to ten iterations.'
        );
      if ('model' in values)
        requireThat(
          typeof values.model === 'string' && values.model.length <= 200,
          'Choose a model or use the issue default.'
        );
      if ('lane' in values) validLane(values.lane);
      if ('edits' in values)
        requireThat(
          Array.isArray(values.edits) &&
            values.edits.length <= 50 &&
            values.edits.every(
              (edit) =>
                typeof edit.id === 'string' &&
                typeof edit.text === 'string' &&
                edit.text.length <= 2000 &&
                typeof edit.enabled === 'boolean'
            ),
          'Supply a valid edit checklist.'
        );
      Object.assign(block, values);
      if ('lane' in values) block.after = blockDependencies(next, block, next.blocks.indexOf(block));
    },
    move() {
      requireEditable(block);
      requireThat(block.kind !== 'request', 'Request stays at the beginning.');
      const at = next.blocks.indexOf(block);
      const to = input.targetId
        ? next.blocks.findIndex((item) => item.id === input.targetId)
        : at + (input.direction === 'up' ? 1 : -1);
      requireThat(
        (input.targetId || ['up', 'down'].includes(input.direction)) && to > 0 && to < next.blocks.length && to !== at,
        'Choose a different block after Request.'
      );
      next.blocks = reorderedBlocks(next, at, to, { insert: Boolean(input.targetId) });
    },
    remove() {
      requireEditable(block);
      requireThat(block.kind !== 'request', 'Keep the original Request.');
      requireThat(
        !block.attempts.some(
          (attempt) => !attempt.reconciledAt && ['running', 'stopping', 'uncertain'].includes(attempt.status)
        ),
        'Stop or reconcile the block before removing it.'
      );
      if (block.attempts.length || block.comments.length || block.id.startsWith('target-'))
        (next.retiredBlocks ??= []).push(block);
      next.blocks = next.blocks.filter((item) => item.id !== block.id);
      next.blocks.forEach((item) => {
        item.after = item.after.flatMap((id) => (id === block.id ? block.after : [id]));
      });
    },
    comment() {
      requireThat(
        block && typeof input.text === 'string' && input.text.trim() && input.text.length <= 12000,
        'Enter a comment under 12,000 characters.'
      );
      block.comments.push({ id: randomUUID(), text: input.text.trim(), at: new Date().toISOString() });
    },
  };
  requireThat(Object.hasOwn(actions, input.action), 'Choose a supported flow edit.');
  actions[input.action]();
  joinPendingLanes(next.blocks);
  return next;
}
export function folderName(value) {
  requireThat(
    value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= 80),
    'Use a folder name under 80 characters.'
  );
  return value === null ? null : value.trim();
}
function validLane(value) {
  requireThat(Number.isInteger(value) && value >= 0 && value <= 3, 'Choose a lane between zero and three.');
  return value;
}
function linkPreWorkUpdate(blocks) {
  const index = updateBranchIndex(blocks);
  const work = blocks[index];
  const update = blocks[index - 1];
  if (!work || !isWorkBlock(work) || update?.kind !== 'update-branch') return;
  if (!work.after.includes(update.id)) work.after.push(update.id);
}

export function isWorkBlock(block) {
  return ['work', 'tdd', 'edit'].includes(block.kind);
}

function defaultInsertionIndex(blocks, kind) {
  return kind === 'update-branch'
    ? updateBranchIndex(blocks)
    : blocks.findIndex((item) => item.suggested || item.kind === 'publish');
}

function requireEditable(block) {
  requireThat(block, 'Choose a saved block.');
}
