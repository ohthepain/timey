export const executionPermissionInstructions = `When an authorized local check cannot open its temporary server because the command sandbox reports listen EPERM or listen EACCES, request native execution permission for that exact check command and rerun it after approval. With exec_command, use sandbox_permissions: "require_escalated" and a justification naming the temporary local server. Do not repeat the restricted command unchanged or treat the refusal as a project test failure. If permission requests are unavailable or the request is denied, stop and report that restriction and the uncollected proof. Keep the normal permission review; do not change global permissions or bypass a denial.`;

function localListenerRefusal(failure) {
  return typeof failure === 'string' && /\blisten\s+(?:EPERM|EACCES)\b/i.test(failure);
}

export function localServerPermissionRecovery(failure, alreadyAttempted, originalWork) {
  if (alreadyAttempted || !localListenerRefusal(failure)) return null;
  if (/(?:permission request|approval|escalation)[^.\n]*(?:denied|rejected|unavailable|forbidden)/i.test(failure))
    return null;
  return JSON.stringify({
    originalWork,
    task: executionPermissionInstructions,
    failure,
    retryLimit: 1,
  });
}
