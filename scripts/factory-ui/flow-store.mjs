import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, writeJson } from './common.mjs';

export const blockCatalog = [
  ['request', 'Request', 'neutral', [], 'Keep the goal, done check, proof, known facts, and constraints together.'],
  [
    'sharpen',
    'Sharpen',
    'yellow',
    ['sharpen', 'grill-me', 'grill-with-docs', 'in-your-own-words'],
    'Reach a shared understanding before choosing work.',
  ],
  [
    'understand',
    'Understand',
    'yellow',
    ['how', 'why', 'teach', 'recall'],
    'Read the system and explain what matters for this request.',
  ],
  [
    'design',
    'Design',
    'yellow',
    ['architect', 'arena', 'swarm', 'interrogate', 'grill-with-docs'],
    'Compare designs and retain the decision.',
  ],
  [
    'advice',
    'Advice',
    'yellow',
    ['poteto-help', 'sharpen'],
    'Recommend skills and routing without starting the proposed work.',
  ],
  [
    'playbook',
    'Playbook',
    'yellow',
    ['poteto-mode', 'figure-it-out'],
    'Propose a sequence of blocks for the user to review.',
  ],
  ['repro', 'Reproduce', 'orange', [], 'Reproduce the reported behavior and retain the actual result.'],
  ['prototype', 'Prototype', 'green', [], 'Build and run a prototype, then collect comments here.'],
  ['tdd', 'TDD', 'green', ['tdd'], 'Write and run a failing behavior test before implementation.'],
  ['work', 'Work', 'green', ['poteto-mode', 'arena', 'swarm'], 'Complete only this block using the selected skill.'],
  ['edit', 'Edit', 'green', ['edit'], 'Apply only enabled items in the edit checklist.'],
  [
    'benchmark',
    'Benchmark',
    'orange',
    ['benchmark-checklist'],
    'Measure the intended work and retain repeatable command evidence.',
  ],
  ['sol', 'Sol loop', 'orange', [], 'Run the chosen number of review iterations with Sol.'],
  ['verify', 'Verify', 'orange', [], 'Run explicit candidate checks and retain their output.'],
  ['merge-target', 'Merge from target', 'blue', [], 'Merge the current target into the issue branch when you choose.'],
  ['publish', 'Publish PR', 'blue', [], 'Push the verified issue branch and publish its pull request when you choose.'],
  ['merge', 'Merge', 'blue', [], 'Inspect the current pull request and use protected merge controls.'],
  [
    'retro',
    'Retro',
    'yellow',
    ['retro', 'show-me-your-work'],
    'Explain what happened and record suggested follow-up issues.',
  ],
  ['close', 'Close', 'neutral', [], 'Record explicit acceptance through the existing closure checks.'],
  [
    'delete-worktree',
    'Delete worktree',
    'neutral',
    [],
    'Inspect retained resources before removing the issue checkout.',
  ],
].map(([kind, label, color, skills, description]) => ({ kind, label, color, skills, description }));

export const requestFields = ['wording', 'goal', 'doneCheck', 'proof', 'knownFacts', 'constraints'];
export function requireIssueId(id) {
  requireThat(typeof id === 'string' && /^[\w-]{1,100}$/.test(id), 'Choose a valid saved issue.');
}
export function inferRequest(wording) {
  const field = (names) => wording.match(new RegExp(`^(?:[-*]\\s*)?(?:${names})\\s*:\\s*(.+)$`, 'im'))?.[1] || '';
  return {
    wording,
    goal:
      field('goal') ||
      wording
        .split('\n')
        .find((line) => line.trim())
        ?.slice(0, 2000) ||
      '',
    doneCheck: field('done(?: check)?|acceptance|success'),
    proof: field('proof|evidence'),
    knownFacts: field('known(?: facts)?|context|symptom|repro'),
    constraints:
      field('constraints?') ||
      [
        ...wording.matchAll(
          /(?:don't change any code yet|zero behavior change|repro first|let me review before proceeding)/gi
        ),
      ]
        .map((m) => m[0])
        .join('\n'),
  };
}
export function inferType(wording) {
  if (/\b(investigate|understand|explain|why does|research)\b/i.test(wording)) return 'investigation';
  return /\b(bug|broken|crash|fails?|error|regression|doesn't work)\b/i.test(wording) ? 'bug' : 'feature';
}
export function makeBlock(kind, after = [], suggested = false) {
  const entry = blockCatalog.find((item) => item.kind === kind);
  requireThat(entry, 'Choose a known block type.');
  return {
    id: randomUUID(),
    kind,
    label: entry.label,
    skill: null,
    prompt: '',
    iterations: 1,
    lane: 0,
    after,
    suggested,
    edits: [],
    comments: [],
    attempts: [],
  };
}
function originalWording(issue) {
  return (
    issue.content
      .match(/^## (?:Original request|Relevant original wording)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]
      ?.trim() || issue.title
  );
}
export function newFlow(issue, target) {
  const request = makeBlock('request');
  request.id = 'request';
  const type = issue.request_type || inferType(originalWording(issue));
  const work = makeBlock(type === 'investigation' ? 'understand' : 'work', [request.id]);
  work.id = 'work';
  const verify = makeBlock('verify', [work.id], true);
  verify.id = 'verify';
  const publish = makeBlock('publish', [verify.id], true);
  publish.id = 'publish';
  const merge = makeBlock('merge', [publish.id], true);
  merge.id = 'merge';
  const close = makeBlock('close', [merge.id], true);
  close.id = 'close';
  return {
    version: 1,
    issueId: issue.id,
    revision: 0,
    type,
    folder: null,
    request: inferRequest(originalWording(issue)),
    target,
    workspace: null,
    blocks:
      type === 'investigation'
        ? [request, work, { ...close, after: [work.id] }]
        : [request, work, verify, publish, merge, close],
  };
}
export class FlowStore {
  constructor(root) {
    this.directory = join(root, '.issues/flows');
  }
  path(id) {
    requireIssueId(id);
    return join(this.directory, id, 'flow.json');
  }
  read(issue, target) {
    const path = this.path(issue.id);
    if (!existsSync(path)) return newFlow(issue, target);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    requireThat(
      record.version === 1 && record.issueId === issue.id && Array.isArray(record.blocks),
      'The saved flow needs reconciliation. It was not reset.'
    );
    return record;
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
export function editFlow(flow, input) {
  const next = structuredClone(flow);
  const block = next.blocks.find((item) => item.id === input.blockId);
  const actions = {
    request() {
      requireThat(['bug', 'feature', 'investigation'].includes(input.type), 'Choose bug, feature, or investigation.');
      requireThat(
        input.request &&
          requestFields.every((name) => typeof input.request[name] === 'string' && input.request[name].length <= 24000),
        'Enter valid request fields.'
      );
      next.type = input.type;
      next.request = Object.fromEntries(requestFields.map((field) => [field, input.request[field]]));
    },
    folder() {
      next.folder = folderName(input.folder);
    },
    add() {
      const explicit = input.afterId ? next.blocks.findIndex((item) => item.id === input.afterId) : -1;
      requireThat(!input.afterId || explicit >= 0, 'Choose an existing insertion point.');
      const index = explicit >= 0 ? explicit + 1 : next.blocks.findIndex((item) => item.suggested);
      const at = index < 0 ? next.blocks.length : index;
      const added = makeBlock(input.kind, at ? [next.blocks[at - 1].id] : []);
      added.lane = validLane(input.lane ?? 0);
      added.after = laneDependencies(next.blocks, at, added.lane);
      next.blocks.splice(at, 0, added);
      const following = next.blocks[at + 1];
      if (following && !following.attempts.length && following.lane === added.lane) following.after = [added.id];
    },
    update() {
      requireEditable(block);
      const values = input.changes;
      requireThat(values && typeof values === 'object', 'Supply block edits.');
      for (const key of Object.keys(values))
        requireThat(['label', 'skill', 'prompt', 'iterations', 'lane', 'edits'].includes(key), 'Unknown block edit.');
      if ('label' in values)
        requireThat(
          typeof values.label === 'string' && values.label.trim() && values.label.length <= 160,
          'Use a block label under 160 characters.'
        );
      if ('skill' in values)
        requireThat(
          values.skill === null || (typeof values.skill === 'string' && /^[\w:-]{1,100}$/.test(values.skill)),
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
      if ('skill' in values && block.attempts.length)
        requireThat(
          values.skill === block.skill,
          'Keep the original skill for this block. Add a new block to choose another method.'
        );
      Object.assign(block, values);
      if ('lane' in values) block.after = laneDependencies(next.blocks, next.blocks.indexOf(block), block.lane);
    },
    move() {
      requireEditable(block);
      requireThat(block.kind !== 'request', 'The request stays at the beginning.');
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
      requireThat(
        block.kind !== 'request' && !block.attempts.length,
        'Keep the original request and attempted blocks as history.'
      );
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
function requireEditable(block) {
  requireThat(block, 'Choose a saved block.');
  requireThat(
    !['running', 'stopping', 'uncertain'].includes(block.attempts.at(-1)?.status),
    'Stop or reconcile this block before changing it.'
  );
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
