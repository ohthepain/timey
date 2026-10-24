import { requireThat } from './common.mjs';

const labels = {
  accept: ['Allow once', 'This request only.'],
  acceptForSession: ['Allow for this chat', 'Reuse this approval within the Codex session for matching requests.'],
  decline: ['Decline', 'Do not grant access; let Codex continue.'],
  cancel: ['Decline and stop', 'Do not grant access; stop this turn.'],
};
export function approvalOptions(request) {
  if (request.method === 'item/permissions/requestApproval') return permissionOptions(request);
  const choices = request.params.availableDecisions ?? defaultDecisions(request.method);
  return choices.map((decision, index) => ({
    id: `option:${index}`,
    ...describeDecision(decision),
    response: { decision },
  }));
}
function defaultDecisions(method) {
  return method === 'item/fileChange/requestApproval'
    ? ['accept', 'acceptForSession', 'decline', 'cancel']
    : ['accept', 'decline'];
}
function describeDecision(decision) {
  if (typeof decision === 'string') {
    const [label, detail] = labels[decision] || ['Unsupported choice', ''];
    return { label, detail };
  }
  return describePersistentDecision(decision);
}
function describePersistentDecision(decision) {
  if (decision.acceptWithExecpolicyAmendment)
    return {
      label: 'Always allow this command pattern',
      detail: decision.acceptWithExecpolicyAmendment.execpolicy_amendment.join(' '),
    };
  const rule = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  return { label: rule.action === 'allow' ? 'Always allow this host' : 'Always block this host', detail: rule.host };
}
function permissionOptions(request) {
  const permissions = request.params.permissions;
  return [
    {
      id: 'once',
      label: 'Allow for this turn',
      detail: 'Only the files and network access listed above, for this turn.',
      response: { permissions, scope: 'turn' },
    },
    {
      id: 'session',
      label: 'Allow for this chat',
      detail: 'Reuse the listed access for this Codex session.',
      response: { permissions, scope: 'session' },
    },
    {
      id: 'deny',
      label: 'Decline',
      detail: 'Grant no additional access.',
      response: { permissions: {}, scope: 'turn' },
    },
  ];
}
export function approvalReply(request, choice) {
  const options = approvalOptions(request);
  const id = legacyChoice(request, choice, options);
  const selected = options.find((option) => option.id === id);
  requireThat(selected, 'That permission choice was not offered for this request.');
  return selected.response;
}
function legacyChoice(request, choice, options) {
  if (choice === 'allow') return options[0]?.id;
  if (choice !== 'decline') return choice;
  return declineChoice(request, options);
}
function declineChoice(request, options) {
  if (request.method === 'item/permissions/requestApproval') return 'deny';
  const denied = options.find((option) => option.response.decision === 'decline');
  if (denied) return denied.id;
  return options.find((option) => option.response.decision === 'cancel')?.id;
}
