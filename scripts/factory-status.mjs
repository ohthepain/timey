import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const progress = {
  recommended: ['Not started', 'Choose whether to launch; readiness still needs checking.'],
  reserved: ['Starting', 'Confirm the original chat was created and save its reference.'],
  setup: ['Setting up', 'Check the original chat setup; do not launch a replacement.'],
  running: ['Started', 'Check the recorded chat for a result.'],
  blocked: ['Blocked', 'Review the recorded blocker before continuing.'],
  completed: ['Work finished', 'Review the result; code still needs a separate merge.'],
  assembled: ['Assembled', 'Issue branch checked; complete the issue before opening its PR.'],
  integrated: ['Merged', 'Check the issue for remaining review or acceptance.'],
  reconciled: ['Result reviewed', 'Check the issue for follow-on work or acceptance.'],
  failed: ['Failed', 'Review the failure before choosing another action.'],
  cancelled: ['Cancelled', 'No further work scheduled for this action.'],
};

function selectActions(actions, selectors) {
  if (!selectors.length) return actions;
  return [
    ...new Set(
      selectors.map((selector) => {
        const exact = actions.filter((action) => action.id === selector);
        const matches = exact.length ? exact : actions.filter((action) => action.id.startsWith(selector));
        if (matches.length === 1) return matches[0];
        if (!matches.length) throw Error(`Unknown factory action: ${selector}`);
        throw Error(`Ambiguous factory action: ${selector}. Matches: ${matches.map((action) => action.id).join(', ')}`);
      })
    ),
  ];
}

function shortText(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 180 ? text.slice(0, 177) + '...' : text;
}

function evidencePaths(project, action) {
  if (Array.isArray(action.evidence_links)) return action.evidence_links.map((path) => resolve(project, path));
  const paths =
    String(action.evidence ?? '').match(/(?:\.issues\/|docs\/|\/(?:Users|private|tmp|var)\/)[^\s"'`<>()]+/g) ?? [];
  return paths.map((path) => resolve(project, path.replace(/[.,;:]+$/, ''))).filter(existsSync);
}

function evidenceLinks(project, action) {
  const paths = [...new Set(evidencePaths(project, action))];
  if (!paths.length) paths.push(join(project, '.issues/factory.json'));
  return paths.map((path) => ({ path, available: existsSync(path) }));
}

function savedProgress(action) {
  if (action.status === 'completed' && !['implement', 'integrate'].includes(action.kind))
    return ['Work finished', 'Coordinator review of the recorded result.'];
  return progress[action.status] ?? ['Unknown saved status', 'Inspect the unrecognized saved status.'];
}

const remainingWork = (action) => (Array.isArray(action.remaining) ? action.remaining : [savedProgress(action)[1]]);
const recordedAt = (action) => action.updated ?? action.reserved ?? action.created ?? null;
const latestResult = (action) => shortText(action.summary ?? action.evidence, 'No result recorded.');

function chatReference(action) {
  return {
    threadId: action.threadId ?? null,
    hostId: action.hostId ?? null,
    clientThreadId: action.clientThreadId ?? null,
  };
}

function taskSummary(project, action) {
  return {
    id: action.id,
    title: action.title,
    status: action.status,
    progress: savedProgress(action)[0],
    recorded_at: recordedAt(action),
    result: latestResult(action),
    remaining: remainingWork(action),
    evidence: evidenceLinks(project, action),
    chat: chatReference(action),
    issue_ids: action.issues,
  };
}

const cell = (value) =>
  String(value)
    .replace(/\s+/g, ' ')
    .replace(/[\\|\[\]<>]/g, '\\$&');
const fileLink = (path) => `[${cell(basename(path))}](${path.split('/').map(encodeURIComponent).join('/')})`;

function renderEvidence(links) {
  return links
    .slice(0, 3)
    .map((link) => (link.available ? fileLink(link.path) : `${cell(basename(link.path))} (missing)`))
    .join(', ');
}

function renderStatus(data) {
  const lines = ['Last recorded factory status; this does not check live chats.', ''];
  if (!data.tasks.length) return lines.concat(data.message).join('\n');
  lines.push(
    '| Task | Saved progress | Latest recorded result | Remaining work | Evidence |',
    '| --- | --- | --- | --- | --- |'
  );
  for (const task of data.tasks) {
    const remaining = shortText(task.remaining.join(' '), 'No further work recorded for this action.');
    lines.push(
      `| ${cell(task.title)} (${cell(task.id.slice(0, 8))}) | ${cell(task.progress)} | ${cell(task.result)} | ${cell(remaining)} | ${renderEvidence(task.evidence)} |`
    );
  }
  lines.push('', 'For the full saved record: /factory status ACTION_ID --details. Issue acceptance is separate.');
  return lines.join('\n');
}

function statusOptions(args) {
  const flags = args.filter((arg) => arg.startsWith('--'));
  if (flags.some((flag) => !['--json', '--details'].includes(flag)))
    throw Error('Usage: factory status [ACTION_ID ...] [--json | --details]');
  const selectors = args.filter((arg) => !arg.startsWith('--'));
  if (flags.includes('--details') && selectors.length !== 1) throw Error('Request --details for exactly one action.');
  return { flags, selectors };
}

function statusData(project, registry, actions) {
  return {
    project,
    source: 'Saved factory records, not live chat status or a readiness assessment.',
    message: registry
      ? 'No factory actions recorded.'
      : 'Factory records are missing. Recover existing chats before initializing anything.',
    tasks: actions.map((action) => taskSummary(project, action)),
  };
}

export function statusOutput(project, registry, args) {
  const { flags, selectors } = statusOptions(args);
  const actions = selectActions((registry ?? { actions: [] }).actions, selectors);
  if (flags.includes('--details')) {
    return { project, action: actions[0] };
  }
  const data = statusData(project, registry, actions);
  return flags.includes('--json') ? data : renderStatus(data);
}

// Optional concise reporting fields; these never confer launch, merge or acceptance authority.
const summaryValidators = {
  summary: (value) => typeof value === 'string' && Boolean(value.trim()),
  remaining: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && Boolean(item.trim())),
  evidence_links: (value) =>
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && Boolean(item.trim()) && !item.includes('://')),
};

function validateStatusSummary(update) {
  for (const [key, valid] of Object.entries(summaryValidators)) {
    if (update[key] !== undefined && !valid(update[key])) throw Error(`Invalid status summary field: ${key}`);
  }
}

export function recordStatusSummary(action, update) {
  validateStatusSummary(update);
  for (const key of Object.keys(summaryValidators)) {
    delete action[key];
    if (update[key] !== undefined) action[key] = update[key];
  }
}
