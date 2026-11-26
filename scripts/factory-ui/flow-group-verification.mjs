import { redactValue } from './activity.mjs';
import { writeDiscussionEvidence } from './discussion-evidence.mjs';

const outputLimit = 1024 * 1024;
const commandTypes = new Set(['commandExecution', 'dynamicToolCall']);

function matchesProviderId(observed, expected) {
  return !observed || !expected || observed === expected;
}

function fromVerificationTurn(params, threadId, turn) {
  return matchesProviderId(params.threadId, threadId) && matchesProviderId(params.turnId, turn?.turnId);
}

function appendOutput(commands, { itemId, delta }) {
  const command = commands.get(itemId);
  if (command) keepOutput(command, command.output + delta);
}

function keepOutput(command, text) {
  if (!text || text.length <= command.output.length) return;
  command.output = text.slice(0, outputLimit);
  if (text.length > outputLimit) command.truncated = true;
}

function commandInput(item) {
  const command = item.command ?? item.arguments?.command;
  return typeof command === 'string' ? { command, output: '' } : undefined;
}

function commandOutput(item) {
  const output = item.aggregatedOutput ?? item.output;
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function recordCommand(commands, { item = {} }, status) {
  if (!commandTypes.has(item.type)) return;
  const command = commands.get(item.id) ?? commandInput(item);
  if (!command) return;
  commands.set(item.id, updateCommand(command, item, status));
}

function updateCommand(command, item, status) {
  keepOutput(command, commandOutput(item));
  return Object.assign(command, { exitCode: item.exitCode, status: item.status ?? status });
}

function retainCommandLog(folder, { command, output, truncated, exitCode, status }, index) {
  const contents = redactValue(
    [
      `$ ${command}`,
      output,
      truncated ? '[Output truncated]' : '',
      `Status: ${status}, exit: ${exitCode ?? 'unknown'}`,
    ].join('\n')
  );
  return { ...writeDiscussionEvidence(folder, `command-${index + 1}.log`, contents), command: redactValue(command) };
}

export function captureGroupVerification(folder, { head, tree }) {
  const commands = new Map();
  const events = new Map([
    ['item/commandExecution/outputDelta', (params) => appendOutput(commands, params)],
    ['item/started', (params) => recordCommand(commands, params, 'running')],
    ['item/completed', (params) => recordCommand(commands, params, 'completed')],
  ]);
  let readingThread;
  let turn;
  let retained;
  return {
    begin(threadId) {
      readingThread = threadId;
    },
    accepted({ threadId, turnId }) {
      turn = { head, tree, threadId, turnId };
    },
    event({ method, params = {} }) {
      if (!readingThread) return;
      if (fromVerificationTurn(params, readingThread, turn)) events.get(method)?.(params);
    },
    retain(proof) {
      if (!turn) return null;
      if (retained) return retained;
      const logs = [...commands.values()].map((command, index) => retainCommandLog(folder, command, index));
      const index = writeDiscussionEvidence(
        folder,
        'verification.json',
        JSON.stringify({ ...turn, proof, logs }, null, 2)
      );
      retained = { ...index, label: 'Final group verification', groupVerification: turn };
      return retained;
    },
  };
}
