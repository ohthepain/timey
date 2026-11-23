import { requireThat } from './common.mjs';
import { executionPermissionInstructions, permissionRequestRefused } from './execution-permissions.mjs';

const continuationLimit = 3;
const checkRepairLimit = 3;
const blockerKinds = new Set(['human-input', 'permission-denied', 'permission-unavailable', 'external-dependency']);

function failureReason(manifest) {
  if (typeof manifest?.failure !== 'string') return null;
  return manifest.failure.trim() || null;
}

export function createWorkProgress() {
  let continuations = 0;
  let checkRepairs = 0;

  function followup(manifest, originalWork) {
    const reason = failureReason(manifest);
    if (!reason) return null;
    if (blockerKinds.has(manifest.blocker)) return null;
    if (permissionRequestRefused(reason)) return null;
    requireThat(
      continuations < continuationLimit,
      `Work still has unfinished steps after ${continuationLimit} continuations. Last report: ${reason}`
    );
    continuations++;
    return JSON.stringify({
      originalWork,
      previousResult: manifest,
      task: [
        'Continue the authorized work in this same checkout and conversation. Finish the next available implementation or verification step, including collecting requested proof. Read retained evidence before repeating a check.',
        'An uncollected measurement or another step you can perform is unfinished work. It is not a blocker. Honor the requested proof without inventing extra evidence requirements.',
        executionPermissionInstructions,
        'Stop only for a concrete human input requirement, denied or unavailable native permission, or unavailable external dependency. Pair the failure reason with blocker: human-input, permission-denied, permission-unavailable, or external-dependency. Do not make a human decision yourself.',
      ].join('\n'),
      continuation: continuations,
      continuationLimit,
    });
  }

  function checkFailed(error) {
    if (checkRepairs >= checkRepairLimit) throw error;
    checkRepairs++;
  }
  return { followup, checkFailed };
}
