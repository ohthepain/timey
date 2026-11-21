import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanEnvironment, requireThat } from './common.mjs';

import { queueMetadataPath } from './shared-issue-config.mjs';

const executeAsync = promisify(execFile);

export function pushSharedIssueCommit(root, request) {
  try {
    const result = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./shared-issue-app-push.mjs', import.meta.url))],
      {
        cwd: root,
        env: cleanEnvironment(),
        input: JSON.stringify(request),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      }
    ).trim();
    return result ? JSON.parse(result) : undefined;
  } catch (error) {
    if (error.status === 2) throw Error('Could not authenticate as the Timey Software Factory GitHub App.');
    throw Error('The Timey Software Factory GitHub App could not push to the queue branch. Check its GitHub ruleset.');
  }
}

export function createSharedIssueGit({
  root,
  remote = 'origin',
  target = 'issue-queue',
  transport,
  repository,
  pushDirect,
}) {
  requireThat(typeof remote === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(remote), 'Invalid queue remote.');
  const targetRef = `refs/heads/${target}`;
  const snapshotRef = 'refs/worktree/timey/shared-issue-claims-target';
  const environment = () => ({ ...cleanEnvironment(), ...transport?.environment(), GIT_TERMINAL_PROMPT: '0' });
  function execute(args, input, extraEnvironment = {}) {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...environment(), ...extraEnvironment },
      stdio: 'pipe',
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      input,
    });
  }
  execute(['check-ref-format', targetRef]);
  requireThat(!target.startsWith('claims/'), 'Queue target cannot be a claim branch.');
  const fetchArgs = [
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    '--refmap=',
    '--',
    remote,
    `+${targetRef}:${snapshotRef}`,
  ];
  function fetch() {
    execute(fetchArgs);
    return execute(['rev-parse', '--verify', snapshotRef]).trim();
  }
  async function fetchAsync() {
    await executeAsync('git', ['-C', root, ...fetchArgs], { env: environment(), timeout: 30_000 });
    return execute(['rev-parse', '--verify', snapshotRef]).trim();
  }
  function commit(head, changes, message) {
    const temporary = mkdtempSync(join(tmpdir(), 'timey-claim-index-'));
    try {
      const env = { GIT_INDEX_FILE: join(temporary, 'index') };
      execute(['read-tree', head], undefined, env);
      for (const [path, content] of changes) {
        requireThat(queueMetadataPath(path), 'Queue writes may only change issue metadata.');
        if (content === null) execute(['update-index', '--force-remove', '--', path], undefined, env);
        else {
          const blob = execute(['hash-object', '-w', '--stdin'], content).trim();
          execute(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], undefined, env);
        }
      }
      const tree = execute(['write-tree'], undefined, env).trim();
      return execute([
        '-c',
        'user.name=Timey Factory',
        '-c',
        'user.email=factory@timey.invalid',
        'commit-tree',
        tree,
        '-p',
        head,
        '-m',
        message,
      ]).trim();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  function push(commit, expectedHead) {
    requireThat(
      execute(['rev-parse', `${commit}^`]).trim() === expectedHead,
      'The queue commit must directly extend its expected head.'
    );
    if (pushDirect) return pushDirect(commit, targetRef, undefined, expectedHead);
    if (repository) return pushSharedIssueCommit(root, { repository, targetRef, commit, expectedHead });
    execute([
      'push',
      '--no-follow-tags',
      '--recurse-submodules=no',
      `--force-with-lease=${targetRef}:${expectedHead}`,
      '--',
      remote,
      `${commit}:${targetRef}`,
    ]);
  }
  function legacyClaims() {
    return execute(['ls-remote', '--heads', '--', remote, 'refs/heads/claims/*']).trim();
  }
  return { execute, fetch, fetchAsync, commit, push, legacyClaims };
}
