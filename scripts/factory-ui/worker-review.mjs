import { completionReviewSchema, completionPrompt } from './completion-contract.mjs';
import { conversationPrompt } from './conversation-context.mjs';
import { mkdirSync } from 'node:fs';
import { redactValue } from './activity.mjs';
import { join } from 'node:path';
import { writeJson } from './common.mjs';
import { reviewPrompt, reviewSchema } from './review-result.mjs';

// Retain the selected RPC result, not the raw session log or another chat's history.
export async function readWorkerReview(service, run, queue, issue, action, worker, guards) {
  const receipt = join(service.store.directory, run.id, 'worker-result.json');
  const { transcriptPath, ...selected } = worker;
  mkdirSync(join(service.store.directory, run.id), { recursive: true });
  writeJson(receipt, redactValue(selected));
  service.store.update(run, { workerResultPath: receipt });
  let prompt = reviewPrompt(queue, issue, action, { ...selected, resultPath: receipt }, guards);
  if (run.completionContext)
    prompt +=
      '\nAlso assess issue completion in this same independent review. Keep outcome about the selected assignment, and return completion separately for the whole approved implementation. Return completion:null if its evidence cannot yet be assessed. ' +
      completionPrompt(run.completionContext.context, run.completionContext.delivery);
  const result = await readResult(service, run, prompt);
  if (!citesTranscript(result, transcriptPath)) return result;
  service.store.update(run, {
    rejectedResult: result,
    summary: 'Saving the worker’s result without requiring access to its chat log.',
  });
  throw Error(
    'The review cites its worker’s raw chat log. The result is retained for manual attention; no additional file permission is needed.'
  );
}
function readResult(service, run, prompt) {
  return service.codex
    .turn(
      run.threadId,
      service.root,
      conversationPrompt(service, run, prompt),
      run.completionContext
        ? {
            ...reviewSchema,
            properties: {
              ...reviewSchema.properties,
              completion: { ...completionReviewSchema, type: ['object', 'null'] },
            },
            required: [...reviewSchema.required, 'completion'],
          }
        : reviewSchema
    )
    .then(JSON.parse);
}
function citesTranscript(result, path) {
  return path && result.outcome === 'completed' && result.evidence?.includes(path);
}
