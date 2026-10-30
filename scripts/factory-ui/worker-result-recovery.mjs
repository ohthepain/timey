import { CodexConnection } from './codex.mjs';
import { selectedWorkerTurn, pinWorkerTurn } from './worker-turn.mjs';
import { workerResultSchema } from './prompts.mjs';
import { draftHandoff } from './delivery-mode.mjs';
import { git, requireThat } from './common.mjs';

export function parseWorkerResult(text) {
  const result = JSON.parse(text);
  requireThat(
    result &&
      ['completed', 'blocked', 'failed'].includes(result.outcome) &&
      typeof result.implementation_complete === 'boolean' &&
      typeof result.summary === 'string' &&
      typeof result.evidence === 'string' &&
      Array.isArray(result.remaining) &&
      result.remaining.every((x) => typeof x === 'string') &&
      Array.isArray(result.artifacts) &&
      result.artifacts.every((x) => x && typeof x.path === 'string' && typeof x.sha256 === 'string'),
    'Worker returned an invalid result.'
  );
  return result;
}

// Recovery observes the original assignment; it never starts implementation.
export async function recoverWorkerText(service, run, error, options = {}) {
  if (!/invalid protocol data|disconnected|(?:turn\/start|initialize) did not respond/i.test(error.message))
    throw error;
  requireThat(run.kind === 'worker' && run.threadId, error.message);
  const turnId =
    run.completedTurnId ||
    [...(run.events || [])]
      .reverse()
      .map((e) => e.params?.turnId || e.params?.turn?.id)
      .find(Boolean);
  requireThat(
    turnId,
    'Cannot identify the interrupted assignment turn. Reconcile its saved chat; no replacement was started.'
  );
  const cli = options.connection || new CodexConnection({ command: service.codex.command, args: service.codex.args });
  const deadline = Date.now() + (options.waitMs ?? 900000);
  service.store.update(run, {
    summary: 'Connection lost. Checking the original worker turn; no replacement is being started.',
    recoveryCause: error.message,
  });
  try {
    await cli.ready();
    let attached = false;
    for (;;) {
      let turn;
      try {
        turn = await selectedWorkerTurn(cli, run.threadId, turnId);
      } catch (error) {
        if (attached || !/not loaded|no rollout found/i.test(error.message)) throw error;
        await cli.resume(run.threadId, run.checkout);
        attached = true;
        continue;
      }
      if (turn.status === 'completed') {
        const text = turn.items?.filter((x) => x.type === 'agentMessage' && x.phase !== 'commentary').at(-1)?.text;
        requireThat(typeof text === 'string' && text.trim(), 'The completed worker has no final result to recover.');
        service.store.update(run, { completedTurnId: turn.id, recoveredTurnId: turn.id });
        return { text, cli };
      }
      requireThat(
        turn.status === 'inProgress' && Date.now() < deadline,
        'The original worker has not completed. Its chat and checkout are retained; no duplicate work or draft was created.'
      );
      const summary = 'The original worker is still running. Waiting for its result without restarting implementation.';
      if (run.summary !== summary) service.store.update(run, { summary });
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 5000));
    }
  } catch (error) {
    if (!options.connection) cli.close();
    throw error;
  }
}

export async function readWorkerResult(service, run, text, cli = service.codex) {
  try {
    return parseWorkerResult(text);
  } catch (error) {
    service.store.update(run, {
      rejectedWorkerResult: text,
      resultRepairAttempted: true,
      summary:
        'Work returned an invalid result. Correcting the report once in the same chat; implementation will not be repeated.',
    });
    let failure = error;
    if (!run.resultRepairUsed) {
      service.store.update(run, { resultRepairUsed: true });
      let correctionReturned = false;
      try {
        if (cli.resume) await cli.resume(run.threadId, run.checkout, 'read-only');
        const fixed = await cli.turn(
          run.threadId,
          run.checkout,
          'Return ONLY a corrected JSON result for the assignment just completed, matching the supplied schema. Do not run tools, edit files, repeat implementation, run checks, publish or merge. Preserve actual failures and unfinished work. The previous result is retained in this chat.',
          workerResultSchema
        );
        correctionReturned = true;
        // Pin the correction itself, rather than treating it as the original turn.
        service.store.update(run, { completedTurnId: null });
        await pinWorkerTurn({ ...service, codex: cli }, run, fixed);
        return parseWorkerResult(fixed);
      } catch (error) {
        requireThat(
          correctionReturned,
          'The result correction lost its connection. Confirm the original chat is idle before draft handoff: ' +
            error.message
        );
        failure = error;
      }
    }
    requireThat(
      run.deliveryMode === draftHandoff,
      'Result recovery failed: ' + failure.message + ' A verified-delivery route cannot be weakened automatically.'
    );
    const head = git(run.checkout, 'rev-parse', 'HEAD');
    requireThat(
      !run.sourceBranch || git(run.checkout, 'branch', '--show-current') === run.sourceBranch,
      'The retained checkout is on a different branch. Reconcile it before draft handoff.'
    );
    git(run.checkout, 'merge-base', '--is-ancestor', run.base, head);
    requireThat(
      head !== run.base && !git(run.checkout, 'status', '--porcelain'),
      'Result recovery failed; no clean committed contribution is available for draft handoff.'
    );
    service.store.update(run, { resultRecoveryFailure: failure.message });
    return {
      outcome: 'completed',
      implementation_complete: false,
      summary:
        'Draft handoff of a committed contribution after result recovery failed. Implementation completeness is unverified.',
      evidence: `Retained checkout ${run.checkout}; base ${run.base}; candidate ${head}. Result failure: ${failure.message}`,
      remaining: [
        'Worker completion could not be validated. Manually review the contribution and disclosed check results.',
      ],
      artifacts: [],
    };
  }
}
