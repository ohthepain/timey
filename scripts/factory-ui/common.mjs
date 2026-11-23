import { beginActivity, diagnosticContext } from './diagnostic-activity.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  accessSync,
  constants,
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

let gitEnvironmentNames;

function gitExecutableGeneration(path, cwd) {
  if (process.platform === 'win32') return null;
  for (const directory of (path ?? '/usr/bin:/bin').split(delimiter)) {
    const candidate = resolve(cwd, directory, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      const actual = realpathSync(candidate);
      const details = statSync(actual, { bigint: true });
      if (details.isFile())
        return [actual, details.dev, details.ino, details.size, details.mtimeNs, details.ctimeNs].join(':');
    } catch {}
  }
  return null;
}

export function cleanEnvironment() {
  const env = { ...process.env };
  const path = process.env.PATH;
  const cwd = process.cwd();
  const executable = gitExecutableGeneration(path, cwd);
  const selection = JSON.stringify([path, cwd, executable]);
  let names = executable && gitEnvironmentNames?.selection === selection ? gitEnvironmentNames.names : null;
  if (!names) {
    names = new Set(execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n'));
    gitEnvironmentNames =
      executable && gitExecutableGeneration(path, cwd) === executable ? { selection, names } : undefined;
  }
  for (const key of Object.keys(env)) if (names.has(key) || /^GIT_CONFIG_(KEY|VALUE)_/.test(key)) delete env[key];
  return env;
}
const observedGit = new Set(['clone', 'fetch', 'ls-remote', 'merge', 'pull', 'push', 'rebase', 'worktree']);

export function git(root, ...args) {
  const operation = args[0];
  const record = observedGit.has(operation) ? beginActivity('git', operation, diagnosticContext(root)) : null;
  try {
    const output = execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: cleanEnvironment(),
      stdio: 'pipe',
    }).trim();
    record?.('Completed');
    return output;
  } catch (error) {
    record?.('Failed');
    throw error;
  }
}
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const requireThat = (condition, message) => {
  if (!condition) throw Error(message);
};
export function writeJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
export function runLogged(root, command, args, log, onProgress = () => {}, environment = {}) {
  mkdirSync(join(root, '.issues/evidence'), { recursive: true });
  writeFileSync(log, '', { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...cleanEnvironment(), ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (data) => {
      output += data;
      appendFileSync(log, data);
      onProgress(String(data));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      writeFileSync(log, output, { mode: 0o600 });
      if (code === 0) resolve(output);
      else reject(Object.assign(Error(`Required check failed (${code}). See ${log}`), { output, exitCode: code }));
    });
  });
}
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
