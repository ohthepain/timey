import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './common.mjs';

const required = [
  'ready-for-grilling',
  'ready-to-fix',
  'ready-to-verify',
  'ready-for-commit',
  'ready-to-close',
  'closed',
];
export function validateCaptureLifecycle(stages) {
  requireThat(stages.length > 0, 'The capture lifecycle is missing.');
  const states = new Set(stages.map((s) => s.state));
  requireThat(states.size === stages.length, 'The lifecycle repeats a state.');
  const combined = stages.some((s) => s.combinedClarify === true);
  const hasInvestigation = stages.some((s) => s.role === 'ready-for-repro');
  if (!combined) requireThat(hasInvestigation, 'Invalid lifecycle mapping for ready-for-repro.');
  if (hasInvestigation)
    requireThat(stages.filter((s) => s.role === 'ready-for-repro').length === 1, 'The lifecycle repeats Investigate.');
  for (const role of required)
    requireThat(stages.filter((s) => s.role === role).length === 1, `Invalid lifecycle mapping for ${role}.`);
  requireThat(stages.filter((s) => s.role === 'ready-to-prototype').length <= 1, 'The lifecycle repeats Prototype.');
  requireThat(
    stages.every((s) => [...required, 'ready-for-repro', 'ready-to-prototype', 'custom'].includes(s.role)),
    'Unknown lifecycle role.'
  );
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
  const order = path.filter((s) => s.role !== 'custom').map((s) => s.role);
  const expected = [
    required[0],
    ...(hasInvestigation ? ['ready-for-repro'] : []),
    ...(order.includes('ready-to-prototype') ? ['ready-to-prototype'] : []),
    ...required.slice(1),
  ];
  requireThat(JSON.stringify(order) === JSON.stringify(expected), 'The lifecycle roles are out of progression.');
  return path;
}

export function captureRoute(stages, proposal) {
  const path = validateCaptureLifecycle(stages);
  const combined = path.some((s) => s.combinedClarify === true);
  const initialRole =
    combined && proposal.initialRole === 'ready-for-repro' ? 'ready-for-grilling' : proposal.initialRole;
  const target = path.findIndex((s) => s.role === initialRole);
  requireThat(target >= 0, 'The proposed capture stage is not configured.');
  const applicable = combined
    ? proposal.skips.filter((s) => s.role !== 'ready-for-repro' && s.role !== initialRole)
    : proposal.skips;
  const reasons = new Map(applicable.map((s) => [s.role, s.reason]));
  requireThat(reasons.size === applicable.length, 'The capture assessment repeats a skip.');
  const bypassed = path.slice(0, target);
  requireThat(
    applicable.every((s) => bypassed.some((p) => p.role === s.role)),
    'The assessment skips a stage outside its initial route.'
  );
  if (bypassed.some((s) => s.role === 'ready-for-repro'))
    requireThat(proposal.reproduction !== 'required', 'Required investigation cannot be skipped.');
  if (!combined && proposal.category === 'bug')
    requireThat(
      proposal.reproduction !== 'inapplicable',
      'A bug needs investigation or an explicit declined reproduction reason.'
    );
  const custom = bypassed.findIndex((s) => s.role === 'custom');
  const skipped = custom < 0 ? bypassed : bypassed.slice(0, custom);
  for (const stage of skipped) requireThat(reasons.has(stage.role), `Missing initial skip reason for ${stage.role}.`);
  return {
    state: custom < 0 ? path[target].state : bypassed[custom].state,
    skipped: skipped.map((s) => ({ state: s.state, reason: reasons.get(s.role) })),
  };
}

// Read the complete lifecycle table, including custom or invalid rows, so validation
// cannot silently omit a required stage. Canonical legacy tables use row order.
export function captureLifecycle(root) {
  const lines = readFileSync(join(root, '.issues/triage-labels.md'), 'utf8').split('\n');
  const modern = lines.findIndex((line) => /^\|\s*Role\s*\|\s*State\s*\|/i.test(line));
  const legacy = modern < 0;
  const start = legacy ? lines.findIndex((line) => /^\|\s*State\s*\|\s*Meaning\s*\|/i.test(line)) : modern;
  requireThat(start >= 0, 'A configured capture lifecycle table is required.');
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    const cells = line.split('|').map((part) => part.replaceAll('`', '').trim());
    const row = legacy ? legacyStage(cells) : { role: cells[1], state: cells[2], next: cells[3], exit: cells[4] };
    requireThat(row.state && row.role, 'A lifecycle row is incomplete.');
    rows.push(row);
  }
  return legacy ? rows.map((row, i) => ({ ...row, next: rows[i + 1]?.state || '—' })) : rows;
}
function legacyStage([, state, exit]) {
  return {
    state,
    role: [...required, 'ready-for-repro', 'ready-to-prototype'].includes(state) ? state : 'custom',
    exit,
  };
}
