import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIssueChatConnection, attachIssueChat } from './issue-chat-runtime.mjs';
import { listAvailableSkills, selectedSkills, skillInputs } from './skills.mjs';
import { runWorkVerification, workVerificationScript } from './flow-verification.mjs';
import { executeCommand, modelManifest } from './flow-executor.mjs';
import { requireThat } from './common.mjs';

export async function runBranchRepair(input, options = {}) {
  const { run, definition, signal, progress, step, retain } = input;
  const connection = options.connection || createIssueChatConnection();
  const binding = {};
  let turnPending = false;
  const stop = () => connection.close();
  signal.addEventListener('abort', stop, { once: true });
  connection.onEvent = ({ method, params }) => {
    if (method === 'item/started' && params?.item?.command) step(params.item.command);
    if (method === 'item/agentMessage/delta') progress(params.delta || '');
    if (method === 'ui/approval') {
      progress(
        'The repair needs provider permission or human input. Stop and review the retained request before retrying.\n'
      );
      connection.close();
    }
  };
  try {
    let failure = 'Run the blocking checks and repair their failures.';
    const instructions = [
      definition.prompt,
      'This run prepares a candidate for explicit human approval. Do not publish, merge, commit in another checkout, or apply the repair to the original issue branch.',
      'The checkout is an isolated snapshot including the user’s uncommitted changes. Keep all work here. Keep checks and thresholds enabled. You may correct analyzer inputs when actual consumers prove they are incomplete; demonstrate that genuinely unused code still fails.',
      `Comparison base: ${run.comparisonBase}. Blocking check command: ${JSON.stringify([process.execPath, workVerificationScript, '--work-checks', '--base', run.comparisonBase])}.`,
    ].join('\n\n');
    signal.throwIfAborted();
    await connection.ready();
    signal.throwIfAborted();
    const skills = selectedSkills(
      await listAvailableSkills(connection, run.checkout),
      definition.defaultSkill ? [definition.defaultSkill] : []
    );
    const thread = await (options.attach || attachIssueChat)(
      connection,
      run.checkout,
      binding,
      (changes) => {
        Object.assign(binding, changes);
        retain({ threadId: binding.threadId, startup: binding.startup });
      },
      'workspace-write',
      instructions
    );
    for (let round = 1; round <= 3; round++) {
      signal.throwIfAborted();
      step(`Repairing branch (${round}/3)`);
      turnPending = true;
      const output = await connection.turn(thread, run.checkout, failure, undefined, skillInputs(skills));
      turnPending = false;
      progress(output + '\n');
      const reportedFailure = modelManifest(output).failure;
      if (typeof reportedFailure === 'string' && reportedFailure.trim()) throw Error(reportedFailure.trim());
      signal.throwIfAborted();
      failure = await checkBranchRepair(input, round, options.verify || runWorkVerification);
      if (!failure) return;
    }
  } catch (error) {
    if (turnPending && !['completed', 'failed', 'interrupted'].includes(error.terminalStatus)) error.uncertain = true;
    throw error;
  } finally {
    signal.removeEventListener('abort', stop);
    connection.close();
  }
}

async function checkBranchRepair({ run, signal, progress, step, retain }, round, verify) {
  step('Checking branch formatting and Fallow');
  const execute = (command) =>
    executeCommand({ ...command, signal: AbortSignal.any([command.signal, AbortSignal.timeout(900000)]) });
  try {
    const result = await verify(
      { signal, onProgress: progress },
      { checkout: run.checkout, base: run.comparisonBase },
      join(run.folder, `checks-${round}`),
      execute
    );
    retain({ checks: result.evidence });
    return null;
  } catch (error) {
    if (!error.verificationFailure || round === 3 || signal.aborted) throw error;
    const logs = (error.evidence || []).map(({ path }) => readFileSync(path, 'utf8').slice(-16000));
    return `Repair the failed prerequisite checks. Preserve the behavior and coverage they protect.\n${logs.join('\n')}`;
  }
}

export async function reconcileBranchRepair(record) {
  requireThat(
    record.threadId || !record.startup,
    'Chat creation was uncertain. Reconcile the original provider session before retrying.'
  );
  if (!record.threadId) return;
  const connection = createIssueChatConnection();
  try {
    await connection.ready();
    const { thread } = await connection.call('thread/read', { threadId: record.threadId, includeTurns: false });
    requireThat(
      thread.status?.type === 'idle',
      'The original repair worker is still active or uncertain. Stop it before retrying.'
    );
  } finally {
    connection.close();
  }
}
