import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createGitTransactions } from './git-transaction.mjs';
import { writeGitTree, gitCommitIdentity } from './git-tree.mjs';
import { publishGitHubMetadata, githubMetadataHead } from './git-github.mjs';
import { cleanEnvironment } from '../../common.mjs';
import { githubAppCredentials } from '../../github-app.mjs';
import { sharedIssueQueueConfig } from '../../shared-issue-config.mjs';
import { createSharedIssueTransport } from '../../shared-issue-transport.mjs';
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
  let transport;
  async function git(args, { env = {} } = {}) {
    const result = await execute('git', ['-C', root, ...args], {
      env: { ...environment, ...transport?.environment(), ...env },
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
          env: { ...environment, ...transport?.environment(), ...env },
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
    if (terminalStoreFailure(error)) throw error;
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

  transport = createSharedIssueTransport(root, remote);

  async function advertisedHead() {
    if (credentials) return githubMetadataHead({ credentials, repository, branch });
    const found = (await git(['ls-remote', '--heads', '--', remote, target])).trim();
    return found ? found.split(/\s/)[0] : null;
  }

  async function withSnapshot(use) {
    const ref = `refs/worktree/timey/stores/${randomUUID()}`;
    try {
      const advertised = await advertisedHead();
      if (!advertised) return await use(null);
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
  const commitTree = (head, changes) => writeGitTree({ head, changes, prefix, git, plumbing });
  async function publish(commit, head, changes) {
    if (credentials && head && changes.length <= 100) {
      const paths = new Set(
        (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', head, commit])).split('\0')
      );
      return publishGitHubMetadata({
        identity: await gitCommitIdentity(git, head, commit),
        credentials,
        repository,
        branch,
        head,
        changes: changes.filter(([path]) => paths.has(path)),
      });
    }
    return push(commit, head);
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
  async function recoverPush(request, error, attempt) {
    if (terminalStoreFailure(error)) throw error;
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
  async function readTree(head, directory, visit) {
    if (!head) return;
    const entries = (await git(['ls-tree', '-rz', '-l', head, '--', directory])).split('\0').filter(Boolean);
    for (const batch of treeBatches(entries.map(treeEntry))) {
      const objects = batch.map(({ object }) => object).join('\n') + '\n';
      const contents = Buffer.from(await plumbing(['cat-file', '--batch'], objects));
      await visitTreeBatch(contents, batch, visit);
    }
  }
  async function listAt(head, start, visit) {
    const records = [];
    await readTree(head, `${prefix}records/`, (record) => {
      if (record.key.startsWith(start)) return visit ? visit(record) : records.push(record);
    });
    return records.sort((a, b) => a.key.localeCompare(b.key));
  }
  async function receiptsAt(head, visit) {
    const directory = `${prefix}operations/`;
    const receipts = [];
    await readTree(head, directory, (receipt, path) => {
      const entry = { id: path.slice(directory.length, -5), receipt };
      return visit ? visit(entry) : receipts.push(entry);
    });
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
          await publish(await commitTree(head, changes), head, changes);
          return request.receipt;
        });
      } catch (error) {
        const prior = await recoverPush(request, error, attempt);
        if (prior) return prior;
      }
    }
  }
  const transactions = createGitTransactions({
    prefix,
    withSnapshot,
    readPath,
    listAt,
    commitTree,
    push: publish,
    failure,
  });
  const write = (request, changesFor) => transactions.write(request, changesFor, writeOperation);
  return {
    close: () => transport.close(),
    transaction: transactions.run,
    async receipt(operationId) {
      try {
        return await transactions.read((head, changes) => transactions.get(head, changes, operationPath(operationId)));
      } catch (error) {
        throw failure(error);
      }
    },
    async retainedPayloads({ visitRecord, visitReceipt } = {}) {
      try {
        return await withSnapshot(async (head) => ({
          records: await listAt(head, '', visitRecord),
          receipts: await receiptsAt(head, visitReceipt),
        }));
      } catch (error) {
        throw failure(error);
      }
    },
    retireReceipts(request) {
      return write(request, (head) =>
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
        return await transactions.read((head, changes) => {
          const pinned = changes && new Map(changes);
          let records;
          return read({
            get: (key) => transactions.get(head, pinned, recordPath(key)),
            list: async (start) => {
              records ||= transactions.snapshotRecords(head, pinned);
              transactions.trackList(head, start);
              return structuredClone((await records).filter((record) => record.key.startsWith(start)));
            },
          });
        });
      } catch (error) {
        throw failure(error);
      }
    },
    async get(key) {
      try {
        return await transactions.read((head, changes) => transactions.get(head, changes, recordPath(key)));
      } catch (error) {
        throw failure(error);
      }
    },
    async list(start) {
      try {
        return await transactions.read((head, changes) => transactions.list(head, changes, start));
      } catch (error) {
        throw failure(error);
      }
    },
    commit(request) {
      return write(request, async (head, changes) => {
        const checked = await Promise.all(
          request.expected.map(async (item) => [item.key, await transactions.get(head, changes, recordPath(item.key))])
        );
        checkExpected(request.expected, new Map(checked));
        return request.writes.map((write) => [recordPath(write.key), write.record]);
      });
    },
  };
}

function treeEntry(entry) {
  const match = /^100644 blob ([a-f0-9]+) +(\d+)\t(.+)$/.exec(entry);
  assertStore(match, 'Git store records must be regular files.');
  return { object: match[1], bytes: Number(match[2]), path: match[3] };
}

function treeBatchFull(count, bytes) {
  return count === 128 || (count > 0 && bytes > 16 * 1024 * 1024);
}

function* treeBatches(entries) {
  let batch = [];
  let bytes = 0;
  for (const entry of entries) {
    if (treeBatchFull(batch.length, bytes + entry.bytes)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += entry.bytes;
  }
  if (batch.length) yield batch;
}

async function visitTreeBatch(contents, batch, visit) {
  let cursor = 0;
  for (const { object, bytes, path } of batch) {
    const header = Buffer.from(`${object} blob ${bytes}\n`);
    const start = cursor + header.length;
    const end = start + bytes;
    assertStore(contents.subarray(cursor, start).equals(header), 'Git returned an invalid store record batch.');
    assertStore(contents[end] === 10, 'Git returned a truncated store record batch.');
    await visit(JSON.parse(contents.subarray(start, end).toString()), path);
    cursor = end + 1;
  }
  assertStore(cursor === contents.length, 'Git returned unexpected store record contents.');
}

function failure(error) {
  return typeof error.code === 'string' && error.code.startsWith('STORE_')
    ? error
    : storeError(
        'STORE_UNAVAILABLE',
        'The metadata Git operation could not be confirmed. Retain its operation identity for reconciliation.'
      );
}

function terminalStoreFailure(error) {
  return String(error.code).startsWith('STORE_') && error.code !== 'STORE_UNAVAILABLE';
}
