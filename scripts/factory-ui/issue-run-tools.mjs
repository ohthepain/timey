import { requireThat } from './common.mjs';
import { annotationTools } from './issue-annotations.mjs';

const masterTools = [
  {
    type: 'function',
    name: 'master_scope',
    description: 'Read the master revision and attached sub-issues.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    type: 'function',
    name: 'detach_blocked_sub_issue',
    description:
      'Detach a blocked sub-issue from this master if the current Work log and checkout prove its changes can be excluded. Get the current revision with master_scope.',
    inputSchema: {
      type: 'object',
      properties: { subIssueId: { type: 'string' }, revision: { type: 'integer' } },
      required: ['subIssueId', 'revision'],
      additionalProperties: false,
    },
  },
];

function detachInput(input) {
  requireThat(
    typeof input?.subIssueId === 'string' && Number.isSafeInteger(input?.revision),
    'Supply a child ID and current master revision.'
  );
  return input;
}

export function issueRunTools(service, issue, signal, master) {
  const annotations = annotationTools(service, { kind: 'issue', id: issue.id }, signal);
  if (!master) return annotations;
  return {
    definitions: [...annotations.definitions, ...masterTools],
    invoke(name, input) {
      signal.throwIfAborted();
      if (name === 'master_scope') return master.current();
      if (name === 'detach_blocked_sub_issue') return master.detach(detachInput(input));
      return annotations.invoke(name, input);
    },
  };
}
