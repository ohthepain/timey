import { approvalActivity } from './approval-activity.mjs';
import { turnFailure } from './turn-failure.mjs';

const maxText = 100000;
const sensitiveName = /(?:secret|password|token|credential|private_key|access_key)/i;
function environmentSecrets() {
  return Object.entries(process.env)
    .filter(([name, value]) => sensitiveName.test(name) && value.length >= 8)
    .map(([, value]) => value);
}
function redactText(text, secrets = environmentSecrets()) {
  let result = String(text).replace(/\u001b\[[0-9;]*m/g, '');
  for (const value of secrets) result = result.split(value).join('[redacted]');
  return result
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:password|secret_access_key|access_token|api_key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}
export function redactValue(value) {
  return redactTree(value, environmentSecrets());
}
function redactTree(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((child) => redactTree(child, secrets));
  return redactObject(value, secrets);
}
function redactObject(value, secrets) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactTree(child, secrets)]));
}
export function activityForRun(run) {
  const history = { output: (run.output || []).map((entry) => ({ ...entry })) };
  for (const event of run.events || [])
    if (!run.output || event.method === 'turn/completed') recordActivity(history, event);
  return history.output;
}
export function recordActivity(run, event) {
  initializeActivity(run);
  const params = eventParams(event);
  if (event.method === 'turn/completed' && params.turn?.status === 'failed')
    recordItem(
      run,
      { type: 'agentMessage', id: 'failure-' + params.turn.id, status: 'failed', text: turnFailure(params.turn) },
      event.at,
      event.method
    );
  const approval = approvalActivity(event);
  if (approval) recordItem(run, approval, event.at, event.method);
  if (['item/started', 'item/completed'].includes(event.method)) recordItem(run, params.item, event.at, event.method);
  const deltas = { 'item/agentMessage/delta': 'message', 'item/commandExecution/outputDelta': 'command' };
  if (deltas[event.method]) appendDelta(run, params, deltas[event.method], event.at);
  trimActivity(run.output);
}
function recordItem(run, item, at, method) {
  if (!item) return;
  const kinds = { agentMessage: 'message', commandExecution: 'command', fileChange: 'files' };
  const kind = kinds[item.type];
  if (!kind) return;
  const entry = activityEntry(run, item.id, kind, at);
  entry.status = activityStatus(item, method);
  updateCommand(entry, item);
  const text = itemText(item);
  if (text !== null) entry.text = redactText(text).slice(-maxText);
}
function activityStatus(item, method) {
  return item.status || (method === 'item/started' ? 'running' : 'completed');
}
function itemText(item) {
  return item.text ?? item.aggregatedOutput ?? fileChangeText(item);
}
function updateCommand(entry, item) {
  if (item.type !== 'commandExecution') return;
  entry.command = redactText(item.command || 'Command');
  if (item.exitCode !== undefined) entry.exitCode = item.exitCode;
}
function fileChangeText(item) {
  if (item.type !== 'fileChange') return null;
  return (item.changes || []).map((change) => change.path).join('\n');
}
function appendDelta(run, params, kind, at) {
  const entry = activityEntry(run, params.itemId, kind, at);
  entry.text = redactText(entry.text + params.delta).slice(-maxText);
  entry.status = 'running';
}
function activityEntry(run, id, kind, at) {
  const key = id || `${kind}-${run.output.length}`;
  let entry = run.output.find((line) => line.id === key);
  if (!entry) {
    entry = { id: key, kind, at, text: '', status: 'running' };
    run.output.push(entry);
  }
  return entry;
}
function trimActivity(output) {
  let size = output.reduce((sum, line) => sum + line.text.length, 0);
  while (output.length > 500 || size > 200000) size -= output.shift().text.length;
}

function initializeActivity(run) {
  run.output ||= [];
}
function eventParams(event) {
  return event.params || {};
}
