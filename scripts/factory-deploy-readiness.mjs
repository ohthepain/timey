import { existsSync, readFileSync } from 'node:fs';
import { readRuntime } from './factory-ui/runtime.mjs';
import { writeJson } from './factory-ui/common.mjs';

// Deliberately exclude arbitrary response fields, bodies, headers and cookie values.
export async function observeRuntime(url, expected) {
  const http = [],
    start = Date.now();
  try {
    const runtime = await readRuntime(url, (event) => http.push(event));
    const mismatches = Object.keys(expected).filter((key) => runtime[key] !== expected[key]);
    return {
      ...attempt(start, expected, http),
      outcome: mismatches.length ? 'mismatch' : 'ready',
      failure: mismatches.length ? 'identity' : null,
      mismatches,
      observed: observedIdentity(runtime, expected),
    };
  } catch (error) {
    return {
      ...attempt(start, expected, http),
      outcome: 'read-failed',
      failure: failureKind(error, http),
      error: safeError(error),
    };
  }
}
function attempt(start, expected, http) {
  return { at: new Date(start).toISOString(), elapsed_ms: Date.now() - start, expected, http };
}
function observedIdentity(runtime, expected) {
  return Object.fromEntries([...Object.keys(expected), 'pid'].map((key) => [key, identityValue(runtime[key])]));
}
function identityValue(value) {
  if (typeof value === 'string') return value.slice(0, 4096);
  return ['number', 'boolean'].includes(typeof value) ? value : null;
}
function failureKind(error, http) {
  if (http.some((event) => event.ok === false)) return 'http';
  return error.name === 'SyntaxError' ? 'decode' : 'transport';
}
function safeError(error) {
  return { name: knownErrorName(error.name), code: errorCode(error.cause?.code || error.code) };
}
function knownErrorName(name) {
  return ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(name) ? name : 'Error';
}
function errorCode(code) {
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

// A bounded tail plus the first failure and latest failure of each kind survive polling.
export function retainReadiness(receipt, receiptPath, phase, observation) {
  const path = receiptPath + '.readiness.json';
  const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, waits: {} };
  const wait = (data.waits[phase] ||= { attempts: 0, failures: {}, recent: [] });
  wait.attempts++;
  wait.recent = [...wait.recent, observation].slice(-20);
  retainFailure(wait, observation);
  receipt.readiness ||= {};
  receipt.readiness[phase] = { path, attempts: wait.attempts, outcome: observation.outcome };
  writeJson(path, data);
  writeJson(receiptPath, receipt);
}
function retainFailure(wait, observation) {
  if (!observation.failure) return;
  wait.firstFailure ||= observation;
  wait.failures[observation.failure] = observation;
}
