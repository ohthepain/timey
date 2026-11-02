import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './common.mjs';

const required = ['ready-to-fix', 'ready-to-verify', 'ready-for-commit', 'ready-to-close', 'closed'];
const knownRoles = [...required, 'ready-for-grilling', 'ready-for-repro', 'ready-to-prototype', 'custom'];

function stageRoles(stages, role) {
  return stages.filter((s) => s.role === role);
}

function lifecycleFlags(stages) {
  return {
    combined: stages.some((s) => s.combinedClarify === true),
    hasClarify: stages.some((s) => s.role === 'ready-for-grilling'),
    hasInvestigation: stages.some((s) => s.role === 'ready-for-repro'),
  };
}

function assertUniqueStates(stages) {
  requireThat(stages.length > 0, 'The capture lifecycle is missing.');
  const states = new Set(stages.map((s) => s.state));
  requireThat(states.size === stages.length, 'The lifecycle repeats a state.');
}

function assertRoleMappings(stages, flags) {
  const { combined, hasInvestigation } = flags;
  if (!combined) requireThat(flags.hasInvestigation, 'Invalid lifecycle mapping for ready-for-repro.');
  if (hasInvestigation) requireThat(stageRoles(stages, 'ready-for-repro').length === 1, 'The lifecycle repeats Investigate.');
  for (const role of required)
    requireThat(stageRoles(stages, role).length === 1, `Invalid lifecycle mapping for ${role}.`);
  requireThat(stageRoles(stages, 'ready-for-grilling').length <= 1, 'The lifecycle repeats Clarify.');
  requireThat(stageRoles(stages, 'ready-to-prototype').length <= 1, 'The lifecycle repeats Prototype.');
  requireThat(stages.every((s) => knownRoles.includes(s.role)), 'Unknown lifecycle role.');
}

function walkLifecyclePath(stages) {
  const path = [],
    seen = new Set();
  const targets = new Set(stages.filter((s) => s.role !== 'closed').map((s) => s.next));
  const roots = stages.filter((s) => !targets.has(s.state));
  requireThat(roots.length === 1, 'The lifecycle needs one unambiguous starting stage.');
  let stage = roots[0];
  while (stage) {
    requireThat(!seen.has(stage.state), 'The lifecycle has a cycle.');
    seen.add(stage.state);
    path.push(stage);
    if (stage.role === 'closed') {
      requireThat(['—', '-', ''].includes(stage.next), 'Closed must be terminal.');
      break;
    }
    stage = stages.find((s) => s.state === stage.next);
    requireThat(stage, 'The lifecycle has a broken Next link.');
  }
  requireThat(path.length === stages.length && path.at(-1).role === 'closed', 'The lifecycle has unreachable stages.');
  return path;
}

function expectedRoleOrder(path, flags) {
  const order = path.filter((s) => s.role !== 'custom').map((s) => s.role);
  const { hasClarify, hasInvestigation } = flags;
  return [
    ...(hasClarify ? ['ready-for-grilling'] : []),
    ...(hasInvestigation ? ['ready-for-repro'] : []),
    ...(order.includes('ready-to-prototype') ? ['ready-to-prototype'] : []),
    ...required,
  ];
}

export function validateCaptureLifecycle(stages) {
  assertUniqueStates(stages);
  const flags = lifecycleFlags(stages);
  assertRoleMappings(stages, flags);
  const path = walkLifecyclePath(stages);
  const expected = expectedRoleOrder(path, flags);
  const order = path.filter((s) => s.role !== 'custom').map((s) => s.role);
  requireThat(JSON.stringify(order) === JSON.stringify(expected), 'The lifecycle roles are out of progression.');
  return path;
}

function proposedInitialRole(path, proposal) {
  const combined = path.some((s) => s.combinedClarify === true);
  const role = proposal.initialRole;
  return combined && role === 'ready-for-repro' ? 'ready-for-grilling' : role;
}

function roleWithoutGrilling(path, proposal) {
  if (proposal.category === 'bug' && path.some((s) => s.role === 'ready-for-repro')) return 'ready-for-repro';
  return path.some((s) => s.role === 'ready-to-prototype') ? 'ready-to-prototype' : 'ready-to-fix';
}

function captureInitialRole(path, proposal, proposedRole) {
  const grillingConfigured = path.some((s) => s.role === 'ready-for-grilling');
  if (proposedRole !== 'ready-for-grilling' || grillingConfigured) return proposedRole;
  return roleWithoutGrilling(path, proposal);
}

function filterCaptureSkips(path, proposal, proposedRole, initialRole, combined) {
  let skips = proposal.skips;
  if (combined) skips = skips.filter((s) => s.role !== 'ready-for-repro' && s.role !== initialRole);
  else if (!path.some((s) => s.role === 'ready-for-grilling'))
    skips = skips.filter((s) => s.role !== 'ready-for-grilling');
  return skips;
}

function grillingDefaultSkips(path, proposal, skips) {
  const reasons = new Map(skips.map((skip) => [skip.role, skip.reason]));
  if (proposal.category === 'enhancement' && path.some((s) => s.role === 'ready-for-repro'))
    reasons.set('ready-for-repro', 'The request describes an enhancement and has no existing failure to reproduce.');
  return [...reasons].map(([role, reason]) => ({ role, reason }));
}

function captureSkips(path, proposal, proposedRole, initialRole, combined) {
  const skips = filterCaptureSkips(path, proposal, proposedRole, initialRole, combined);
  const grillingConfigured = path.some((s) => s.role === 'ready-for-grilling');
  const applyDefaults = !combined && proposedRole === 'ready-for-grilling' && !grillingConfigured;
  return applyDefaults ? grillingDefaultSkips(path, proposal, skips) : skips;
}

function assertBypassRules(bypassed, proposal, combined) {
  if (bypassed.some((s) => s.role === 'ready-for-repro'))
    requireThat(proposal.reproduction !== 'required', 'Required investigation cannot be skipped.');
  if (!combined && proposal.category === 'bug')
    requireThat(
      proposal.reproduction !== 'inapplicable',
      'A bug needs investigation or an explicit declined reproduction reason.'
    );
}

function skippedStages(bypassed) {
  const custom = bypassed.findIndex((s) => s.role === 'custom');
  return { custom, skipped: custom < 0 ? bypassed : bypassed.slice(0, custom) };
}

export function captureRoute(stages, proposal) {
  const path = validateCaptureLifecycle(stages);
  const combined = path.some((s) => s.combinedClarify === true);
  const proposedRole = proposedInitialRole(path, proposal);
  const initialRole = captureInitialRole(path, proposal, proposedRole);
  const target = path.findIndex((s) => s.role === initialRole);
  requireThat(target >= 0, 'The proposed capture stage is not configured.');
  const applicable = captureSkips(path, proposal, proposedRole, initialRole, combined);
  const reasons = new Map(applicable.map((s) => [s.role, s.reason]));
  requireThat(reasons.size === applicable.length, 'The capture assessment repeats a skip.');
  const bypassed = path.slice(0, target);
  requireThat(
    applicable.every((s) => bypassed.some((p) => p.role === s.role)),
    'The assessment skips a stage outside its initial route.'
  );
  assertBypassRules(bypassed, proposal, combined);
  const { custom, skipped } = skippedStages(bypassed);
  for (const stage of skipped) requireThat(reasons.has(stage.role), `Missing initial skip reason for ${stage.role}.`);
  return {
    state: custom < 0 ? path[target].state : bypassed[custom].state,
    skipped: skipped.map((s) => ({ state: s.state, reason: reasons.get(s.role) })),
  };
}

function lifecycleTableStart(lines) {
  const modern = lines.findIndex((line) => /^\|\s*Role\s*\|\s*State\s*\|/i.test(line));
  if (modern >= 0) return { legacy: false, start: modern };
  const legacy = lines.findIndex((line) => /^\|\s*State\s*\|\s*Meaning\s*\|/i.test(line));
  return { legacy: legacy >= 0, start: legacy };
}

function lifecycleRow(cells, legacy) {
  if (legacy) return legacyStage(cells);
  return { role: cells[1], state: cells[2], next: cells[3], exit: cells[4] };
}

function readLifecycleRows(lines, start, legacy) {
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    const cells = line.split('|').map((part) => part.replaceAll('`', '').trim());
    const row = lifecycleRow(cells, legacy);
    requireThat(row.state && row.role, 'A lifecycle row is incomplete.');
    rows.push(row);
  }
  return rows;
}

// Read the complete lifecycle table, including custom or invalid rows, so validation
// cannot silently omit a required stage. Canonical legacy tables use row order.
export function captureLifecycle(root) {
  const lines = readFileSync(join(root, '.issues/triage-labels.md'), 'utf8').split('\n');
  const { legacy, start } = lifecycleTableStart(lines);
  requireThat(start >= 0, 'A configured capture lifecycle table is required.');
  const rows = readLifecycleRows(lines, start, legacy);
  return legacy ? rows.map((row, i) => ({ ...row, next: rows[i + 1]?.state || '—' })) : rows;
}

function legacyStage([, state, exit]) {
  return {
    state,
    role: [...required, 'ready-for-grilling', 'ready-for-repro', 'ready-to-prototype'].includes(state)
      ? state
      : 'custom',
    exit,
  };
}
