import { mkdirSync } from 'node:fs';
import { redactValue } from './activity.mjs';
import { join } from 'node:path';
import { writeJson, requireThat } from './common.mjs';
import { reviewPrompt, reviewSchema } from './review-result.mjs';

// Retain the selected RPC result, not the raw session log or another chat's history.
export async function readWorkerReview(service, run, queue, issue, action, worker, guards) {
  const receipt = join(service.store.directory, run.id, 'worker-result.json');
  const { transcriptPath, ...selected } = worker;
  mkdirSync(join(service.store.directory, run.id), { recursive: true });
  writeJson(receipt, redactValue(selected));
  service.store.update(run, { workerResultPath: receipt });
  const prompt = reviewPrompt(queue, issue, action, { ...selected, resultPath: receipt }, guards);
  const result = await readResult(service, run, prompt);
  if (!citesTranscript(result, transcriptPath)) return result;
  service.store.update(run, {
    rejectedResult: result,
    summary: 'Saving the worker’s result without requiring access to its chat log.',
  });
  const corrected = await readResult(
    service,
    run,
    `Your review has not been saved. Its citation of the selected worker's raw chat log is a recording restriction, not an access denial. Correct this result in this same read-only chat. Use the retained selected worker result at ${receipt} for its chat ID, turn and result, and actual project/temporary reports and test logs for technical claims. The retained result is a worker claim, not proof tests passed or human approval. If a claim depends on earlier chat history, use existing project approval/answer receipts or report the specific missing evidence. Do not silently drop a required fact, invent a pass, rerun work, request access to the raw session, or change files. Return the full corrected structured result, preserving real remaining work and human requirements.`
  );
  requireThat(
    !citesTranscript(corrected, transcriptPath),
    'The review still cites its worker’s raw chat log. Use the saved worker result and supporting reports; no additional file permission is needed.'
  );
  return corrected;
}
function readResult(service, run, prompt) {
  return service.codex.turn(run.threadId, service.root, prompt, reviewSchema).then(JSON.parse);
}
function citesTranscript(result, path) {
  return path && result.outcome === 'completed' && result.evidence?.includes(path);
}
