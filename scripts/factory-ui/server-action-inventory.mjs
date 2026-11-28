const issueHref = (id) => id && `/?issue=${encodeURIComponent(id)}`;

export function backgroundAction(kind, id, title, target, fields = {}) {
  return { id: `${kind}:${id}`, kind, title, target, status: 'running', ...fields };
}

export function nativeActionItems({ turns = new Map(), pending = new Map() }, project) {
  if (turns.size) {
    return Array.from(turns.keys(), (id) => backgroundAction('codex-turn', id, 'Codex response', id));
  }
  const first = pending.entries().next().value;
  if (!first) return [];
  return [nativeRequest(first, project)];
}

function nativeRequest([id, { threadId = '', method }], project) {
  return backgroundAction('codex-request', id, 'Codex request', threadId || project, {
    status: 'waiting',
    details: method,
  });
}

export function lifecycleActionItems(service, runs) {
  return [...service.lifecycleTasks.keys()]
    .filter((id) => {
      const record = service.lifecycleRuns[id];
      return !runs.has(record?.childRunId) && !runs.has(record?.work?.runId);
    })
    .map((id) =>
      backgroundAction('lifecycle', id, 'Issue strategy', id, {
        issueId: id,
        outputHref: issueHref(id),
        status: service.lifecycleRuns[id]?.status || 'running',
      })
    );
}

export function captureActionItems({ captures = {}, flows }) {
  const { activeFolders = [] } = captures;
  return [
    ...Array.from(activeFolders, ([id, folder]) => backgroundAction('capture', id, 'Capture issue', folder)),
    ...flowActionItems(flows),
  ];
}

function flowActionItems({ captures = [], followups = { busy: [] } } = {}) {
  return [
    ...Array.from(captures, ([id, { folder }]) => backgroundAction('flow-capture', id, 'Capture issue', folder)),
    ...Array.from(followups.busy, ([id, { issueId, title }]) =>
      backgroundAction('followups', id, title, issueId, { issueId, outputHref: issueHref(issueId) })
    ),
  ];
}

export function projectActionItems(
  { projectHome, projectDiscuss, projectRemoteBranchCleanup, projectLocalBranchCleanup },
  project
) {
  return [
    ...homeActionItems(projectHome, project),
    ...Array.from(projectDiscuss?.active ?? [], ([id, active]) => discussAction(id, active)),
    ...[projectRemoteBranchCleanup, projectLocalBranchCleanup].map((cleanup) => cleanup?.action).filter(Boolean),
  ];
}

function discussAction(id, { title = id, ownership }) {
  const issueId = ownership?.issueId;
  return backgroundAction('discussion-response', id, 'Discuss response', title, {
    issueId,
    outputHref: ownership ? issueHref(issueId) : `/?projectTab=discuss&conversation=${encodeURIComponent(id)}`,
  });
}

function homeActionItems({ investigations, automateMe } = {}, project) {
  return [...investigationActionItems(investigations, project), ...automateActionItems(automateMe)];
}

function investigationActionItems({ activeSessions = [], sessions, pending = [] } = {}, project) {
  return [
    ...activeSessions.map((id) => {
      const { focus = project, status = 'running', issueId } = sessions.get(id) || {};
      return backgroundAction('investigation', id, 'Investigation', focus, {
        issueId,
        status,
        outputHref: issueHref(issueId),
      });
    }),
    ...Array.from(pending, ([id, { action, focus }]) =>
      backgroundAction('investigation-request', id, action.replaceAll('-', ' '), focus || project)
    ),
  ];
}

function automateActionItems({ active = new Map(), sessions, applying = [] } = {}) {
  return [
    ...Array.from(active.keys(), (id) =>
      backgroundAction('automate-me', id, 'Automate me response', sessions.get(id)?.destination || id)
    ),
    ...Array.from(applying, (id) =>
      backgroundAction('automate-me-apply', id, 'Apply Automate me skill', sessions.get(id)?.destination || id)
    ),
  ];
}
