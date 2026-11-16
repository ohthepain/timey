import { blockDefinitionId, requestBlock, withoutTarget } from './flow-block-data.mjs';
import { BlockCatalog } from './block-catalog.mjs';
import { bundledFlow } from './flow-definitions.mjs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, writeJson } from './common.mjs';

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
  const target = flow.blocks.find((block) => block.kind === 'target');
  if (target) {
    flow.target ??= target.data?.delivery;
    flow.startingPoint ??= target.data?.startingPoint ?? null;
    flow.blocks = withoutTarget(flow.blocks, target);
    for (const block of flow.blocks)
      for (const key of Object.keys(block.links ?? {})) if (block.links[key] === target.id) delete block.links[key];
    if (target.attempts?.length || target.comments?.length) (flow.retiredBlocks ??= []).push(target);
  }
  migrateUpdateBranchLabels(flow);
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
  return flow;
}

function migrateUpdateBranchLabels(flow) {
  for (const block of [...flow.blocks, ...(flow.retiredBlocks ?? [])])
    if (block.kind === 'merge-target' && block.label === 'Merge from target') block.label = 'Update branch';
}

export function rebuildRoute(flow, type, definition, nodes, catalog) {
  const current = new Map(flow.blocks.filter((block) => block.flowKey).map((block) => [block.flowKey, block]));
  const taken = new Set([...flow.blocks, ...(flow.retiredBlocks ?? [])].map((block) => block.id));
  const ids = new Map();
  const retained = new Set();
  const blocks = nodes.map((node) => {
    const before = current.get(node.id);
    const block =
      before && blockDefinitionId(before) === node.block
        ? { ...before }
        : makeBlock(node.block, [], node.suggested, catalog);
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
  constructor(root) {
    this.directory = join(root, '.issues/flows');
  }
  path(id) {
    requireIssueId(id);
    return join(this.directory, id, 'flow.json');
  }
  read(issue, target, catalog) {
    const path = this.path(issue.id);
    if (!existsSync(path)) return newFlow(issue, target, catalog);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    requireThat(
      record.version === 1 && record.issueId === issue.id && Array.isArray(record.blocks),
      'The saved flow needs reconciliation. It was not reset.'
    );
    return migrateFlow(record, target);
  }
  save(flow, expectedRevision) {
    const path = this.path(flow.issueId);
    const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).revision : 0;
    requireThat(current === expectedRevision, 'This flow changed. Refresh before saving this edit.');
    validateGraph(flow.blocks);
    const saved = { ...flow, revision: current + 1, updatedAt: new Date().toISOString() };
    mkdirSync(join(this.directory, flow.issueId), { recursive: true });
    writeJson(path, saved);
    return saved;
  }
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
export function updateBranchIndex(blocks) {
  const work = blocks.findIndex(isWorkBlock);
  return work >= 0 ? work : blocks.findIndex((block) => block.suggested);
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
      added.lane = validLane(input.lane ?? (input.kind === 'merge-target' ? next.blocks[at]?.lane : 0) ?? 0);
      added.after = laneDependencies(next.blocks, at, added.lane);
      next.blocks.splice(at, 0, added);
      const following = next.blocks[at + 1];
      if (input.kind === 'merge-target') linkPreWorkUpdate(next.blocks);
      else if (following && !following.attempts.length && following.lane === added.lane) following.after = [added.id];
    },
    update() {
      requireEditable(block);
      const values = input.changes;
      requireThat(values && typeof values === 'object', 'Supply block edits.');
      for (const key of Object.keys(values))
        requireThat(
          ['label', 'skill', 'prompt', 'iterations', 'lane', 'edits', 'inputs', 'links'].includes(key),
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
      if ('lane' in values) block.after = laneDependencies(next.blocks, next.blocks.indexOf(block), block.lane);
    },
    move() {
      requireEditable(block);
      requireThat(block.kind !== 'request', 'Request stays at the beginning.');
      const at = next.blocks.indexOf(block),
        to = at + (input.direction === 'up' ? 1 : -1);
      requireThat(
        ['up', 'down'].includes(input.direction) && to > 0 && to < next.blocks.length,
        'This block cannot move further.'
      );
      requireEditable(next.blocks[to]);
      [next.blocks[at], next.blocks[to]] = [next.blocks[to], next.blocks[at]];
      next.blocks.forEach((item, index) => {
        item.after = laneDependencies(next.blocks, index, item.lane);
      });
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
      if (block.attempts.length || block.comments.length) (next.retiredBlocks ??= []).push(block);
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
  joinSuggestions(next.blocks);
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
  if (!work || !isWorkBlock(work) || update?.kind !== 'merge-target') return;
  if (!work.after.includes(update.id)) work.after.push(update.id);
}

function isWorkBlock(block) {
  return ['work', 'tdd', 'edit'].includes(block.kind);
}

function defaultInsertionIndex(blocks, kind) {
  return kind === 'merge-target' ? updateBranchIndex(blocks) : blocks.findIndex((item) => item.suggested);
}

function requireEditable(block) {
  requireThat(block, 'Choose a saved block.');
}

function laneDependencies(blocks, index, lane) {
  const previous = blocks.slice(0, index).findLast((item) => item.lane === lane && !item.suggested) || blocks[0];
  return previous && index > 0 ? [previous.id] : [];
}
function joinSuggestions(blocks) {
  blocks.forEach((block, index) => {
    if (!block.suggested || block.attempts.length) return;
    const prefix = blocks.slice(0, index);
    const parents = new Set(prefix.flatMap((item) => item.after));
    block.after = prefix.filter((item) => !parents.has(item.id)).map((item) => item.id);
  });
}
