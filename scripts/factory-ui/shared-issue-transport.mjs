import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnvironment } from './common.mjs';

function gitSetting(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    env: cleanEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function configuredSSH(root, key) {
  try {
    return Boolean(gitSetting(root, ['config', '--get', key]));
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function defaultSSH(root) {
  const env = cleanEnvironment();
  return (
    process.platform !== 'win32' &&
    !['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT'].some((key) => env[key]) &&
    !['core.sshCommand', 'ssh.variant'].some((key) => configuredSSH(root, key))
  );
}

function reuseHost(root, remote) {
  if (!defaultSSH(root)) return null;
  const url = remoteURL(root, remote);
  return /^git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/.test(url) ? 'git@github.com' : null;
}

function remoteURL(root, remote) {
  try {
    return gitSetting(root, ['remote', 'get-url', remote]);
  } catch (error) {
    if (error.status === 2) return '';
    throw error;
  }
}

function stopConnection(host, socket) {
  if (!existsSync(socket)) return;
  try {
    execFileSync('ssh', ['-O', 'exit', '-o', `ControlPath=${socket}`, host], {
      env: cleanEnvironment(),
      stdio: 'ignore',
      timeout: 1000,
    });
  } catch {}
}

export function createSharedIssueTransport(root, remote) {
  const host = reuseHost(root, remote);
  const directory = host ? mkdtempSync('/tmp/timey-queue-ssh-') : null;
  const socket = directory && join(directory, 'connection');
  const env = socket
    ? { GIT_SSH_COMMAND: `ssh -o ControlMaster=auto -o ControlPersist=60 -o ControlPath=${socket}` }
    : {};
  let closed = false;
  return {
    environment: () => (closed ? {} : env),
    close() {
      if (closed) return;
      closed = true;
      if (!directory) return;
      stopConnection(host, socket);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
