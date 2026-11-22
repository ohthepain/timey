import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanEnvironment } from '../../common.mjs';
import { githubAppCredentials } from '../../github-app.mjs';
import { sharedIssueQueueConfig } from '../../shared-issue-config.mjs';
import { assertStore, checkExpected, hash, storeError, verifyReceipt, retireReceipt } from './records.mjs';

const execute = promisify(execFile);

export async function openGitRecords(config, { root, projectId }) {
  const remote = config.remote || 'origin';
  const branch = config.branch || 'issue-queue';
  const target = `refs/heads/${branch}`;
  assertStore(/^[a-zA-Z0-9][\w.-]*$/.test(remote), 'Configure a named metadata Git remote.');
  assertStore(typeof branch === 'string' && !branch.startsWith('claims/'), 'Configure a dedicated metadata branch.');
  const prefix = `.issues/stores/${hash(projectId)}/${hash(config.id)}/`;
  const environment = { ...cleanEnvironment(), GIT_TERMINAL_PROMPT: '0' };
  async function git(args, { env = {} } = {}) {
    const result = await execute('git', ['-C', root, ...args], {
      env: { ...environment, ...env },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.stdout;
  }
  // execFile does not accept stdin input. Plumbing writes use this explicit pipe.
  async function plumbing(args, input, env = {}) {
    if (input === undefined) return git(args, { env });
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        ['-C', root, ...args],
        {
          env: { ...environment, ...env },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      );
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  try {
    await git(['check-ref-format', target]);
    const current = (await git(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
    assertStore(target !== current, 'The metadata branch cannot be the source checkout branch.');
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('STORE_')) throw error;
    throw storeError('STORE_INVALID', 'The metadata Git branch is invalid.');
  }
  const queue = sharedIssueQueueConfig(root);
  if (queue)
    assertStore(
      branch === queue.target && remote === queue.remote,
      'Shared Git storage must use the configured dedicated issue queue.'
    );
  let remoteURL;
  try {
    remoteURL = (await git(['remote', 'get-url', remote])).trim();
  } catch {
    throw storeError('STORE_INVALID', 'The configured metadata Git remote is unavailable.');
  }
  const github = /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remoteURL);
  const repository = github?.[1];
  const credentials = repository ? githubAppCredentials(root, repository) : null;
  if (queue)
    assertStore(
      credentials && repository === queue.repository,
      'The shared queue requires its configured Factory GitHub App identity.'
    );

  async function withSnapshot(use) {
    const ref = `refs/worktree/timey/stores/${randomUUID()}`;
    try {
      const found = (await git(['ls-remote', '--heads', '--', remote, target])).trim();
      if (!found) return await use(null);
      const advertised = found.split(/\s/)[0];
      let local = false;
      try {
        await git(['cat-file', '-e', `${advertised}^{commit}`]);
        local = true;
      } catch {
        /* Fetch a peer commit that is not present in this object database. */
      }
      if (local) await git(['update-ref', ref, advertised]);
      else await git(['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', '--', remote, `+${target}:${ref}`]);
      return await use((await git(['rev-parse', '--verify', ref])).trim());
    } finally {
      await git(['update-ref', '-d', ref]).catch(() => {});
    }
  }
  const recordPath = (key) => `${prefix}records/${hash(key)}.json`;
  const operationPath = (operation) => `${prefix}operations/${hash(operation)}.json`;
  async function readPath(head, path) {
    if (!head) return null;
    const entry = (await git(['ls-tree', head, '--', path])).trim();
    if (!entry) return null;
    assertStore(entry.startsWith('100644 blob '), 'Git store records must be regular files.');
    return JSON.parse(await git(['show', `${head}:${path}`]));
  }
  async function commitTree(head, changes) {
    const directory = await mkdtemp(join(tmpdir(), 'timey-record-index-'));
    const env = { GIT_INDEX_FILE: join(directory, 'index') };
    try {
      await git(head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
      for (const [path, value] of changes) {
        assertStore(path.startsWith(prefix) && !path.includes('/../'), 'Only dedicated store metadata can be changed.');
        if (value === null) await git(['update-index', '--force-remove', '--', path], { env });
        else {
          const blob = (await plumbing(['hash-object', '-w', '--stdin'], JSON.stringify(value))).trim();
          await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
        }
      }
      const tree = (await git(['write-tree'], { env })).trim();
      return (
        await git([
          '-c',
          'user.name=Timey Factory',
          '-c',
          'user.email=factory@timey.invalid',
          'commit-tree',
          tree,
          ...(head ? ['-p', head] : []),
          '-m',
          'Update Factory store records',
        ])
      ).trim();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async function push(commit, head) {
    let auth = {};
    let args = [];
    if (credentials) {
      const session = await credentials.session();
      assertStore(
        session.permissions.contents === 'write',
        'The Factory GitHub App requires Contents write permission.'
      );
      const url = `https://github.com/${repository}.git`;
      args = [
        '-c',
        `remote.timey-store-app.url=${url}`,
        '-c',
        `remote.timey-store-app.pushurl=${url}`,
        '-c',
        'credential.helper=',
        '-c',
        'http.followRedirects=false',
        '--config-env',
        `http.${url}.extraHeader=TIMEY_STORE_GIT_AUTHORIZATION`,
      ];
      auth = {
        TIMEY_STORE_GIT_AUTHORIZATION:
          'Authorization: Basic ' + Buffer.from(`x-access-token:${session.token}`).toString('base64'),
        GIT_ALLOW_PROTOCOL: 'https',
      };
    }
    const command = [
      'push',
      '--no-mirror',
      '--no-verify',
      '--no-follow-tags',
      '--recurse-submodules=no',
      `--force-with-lease=${target}:${head || ''}`,
      '--',
      credentials ? 'timey-store-app' : remote,
      `${commit}:${target}`,
    ];
    try {
      await git([...args, ...command], { env: auth });
    } catch (error) {
      if (!/RPC failed; HTTP 400\b/.test(error.stderr || '')) throw error;
      await git([...args, '-c', 'http.postBuffer=67108864', ...command], { env: auth });
    }
  }
  function failure(error) {
    return typeof error.code === 'string' && error.code.startsWith('STORE_')
      ? error
      : storeError(
          'STORE_UNAVAILABLE',
          'The metadata Git operation could not be confirmed. Retain its operation identity for reconciliation.'
        );
  }
  async function recoverPush(request, error, attempt) {
    if (typeof error.code === 'string' && error.code.startsWith('STORE_')) throw error;
    let prior;
    try {
      prior = await withSnapshot((head) => readPath(head, operationPath(request.operationId)));
    } catch {
      throw failure(error);
    }
    if (prior) return verifyReceipt(prior, request.inputDigest);
    const contention = /stale info|fetch first|cannot lock ref|failed to update ref|is at .* but expected/.test(
      error.stderr || ''
    );
    if (!contention || attempt === 4) throw failure(error);
    return null;
  }
  async function listAt(head, start) {
    if (!head) return [];
    const paths = (await git(['ls-tree', '-rz', '--name-only', head, '--', `${prefix}records/`]))
      .split('\0')
      .filter(Boolean);
    const records = [];
    let cursor = 0;
    async function readNext() {
      while (cursor < paths.length) {
        const path = paths[cursor++];
        const record = await readPath(head, path);
        if (record.key.startsWith(start)) records.push(record);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, readNext));
    return records.sort((a, b) => a.key.localeCompare(b.key));
  }
  async function receiptsAt(head) {
    if (!head) return [];
    const paths = (await git(['ls-tree', '-rz', '--name-only', head, '--', `${prefix}operations/`]))
      .split('\0')
      .filter(Boolean);
    const receipts = [];
    for (let index = 0; index < paths.length; index += 4)
      receipts.push(
        ...(await Promise.all(
          paths.slice(index, index + 4).map(async (path) => ({
            id: path.slice((prefix + 'operations/').length, -5),
            receipt: await readPath(head, path),
          }))
        ))
      );
    return receipts;
  }
  function retainedOperationPath(id) {
    assertStore(/^[a-f0-9]{64}$/.test(id), 'Choose a retained Git operation identity.');
    return `${prefix}operations/${id}.json`;
  }
  async function writeOperation(request, changesFor) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await withSnapshot(async (head) => {
          const prior = await readPath(head, operationPath(request.operationId));
          if (prior) return verifyReceipt(prior, request.inputDigest);
          const changes = await changesFor(head);
          changes.push([operationPath(request.operationId), request.receipt]);
          await push(await commitTree(head, changes), head);
          return request.receipt;
        });
      } catch (error) {
        const prior = await recoverPush(request, error, attempt);
        if (prior) return prior;
      }
    }
  }
  return {
    async receipt(operationId) {
      try {
        return await withSnapshot((head) => readPath(head, operationPath(operationId)));
      } catch (error) {
        throw failure(error);
      }
    },
    async retainedPayloads() {
      try {
        return await withSnapshot(async (head) => ({
          records: await listAt(head, ''),
          receipts: await receiptsAt(head),
        }));
      } catch (error) {
        throw failure(error);
      }
    },
    retireReceipts(request) {
      return writeOperation(request, (head) =>
        Promise.all(
          request.receipts.map(async (item) => {
            const path = retainedOperationPath(item.id);
            return [path, retireReceipt(await readPath(head, path), item, request)];
          })
        )
      );
    },
    async readSnapshot(read) {
      try {
        return await withSnapshot((head) =>
          read({
            get: (key) => readPath(head, recordPath(key)),
            list: (prefix) => listAt(head, prefix),
          })
        );
      } catch (error) {
        throw failure(error);
      }
    },
    async get(key) {
      try {
        return await withSnapshot((head) => readPath(head, recordPath(key)));
      } catch (error) {
        throw failure(error);
      }
    },
    async list(start) {
      try {
        return await withSnapshot((head) => listAt(head, start));
      } catch (error) {
        throw failure(error);
      }
    },
    commit(request) {
      return writeOperation(request, async (head) => {
        const checked = await Promise.all(
          request.expected.map(async (item) => [item.key, await readPath(head, recordPath(item.key))])
        );
        checkExpected(request.expected, new Map(checked));
        return request.writes.map((write) => [recordPath(write.key), write.record]);
      });
    },
  };
}
