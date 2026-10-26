import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function cleanEnvironment() {
  const env = { ...process.env };
  const keys = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n');
  for (const key of Object.keys(env)) if (keys.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_/.test(key)) delete env[key];
  return env;
}
export function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: cleanEnvironment(),
    stdio: 'pipe',
  }).trim();
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
export function runLogged(root, command, args, log) {
  mkdirSync(join(root, '.issues/evidence'), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (data) => {
      output += data;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      writeFileSync(log, output, { mode: 0o600 });
      if (code === 0) resolve();
      else reject(Error(`Required check failed (${code}). See ${log}`));
    });
  });
}
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
