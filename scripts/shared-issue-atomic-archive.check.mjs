import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedIssueQueue } from './factory-ui/shared-issue-queue.mjs';
import { createSharedIssueClaims } from './factory-ui/shared-issue-claims.mjs';

const id = '20261111T165430736-ca3555165563420b';
const claimRef = 'refs/heads/claims/' + id;
const target = 'refs/heads/issue-queue';
const content = `---\nid: ${id}\ntitle: Atomic archive\nstate: closed\n---\n\n# Closed report\n`;
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t, behavior = {}) {
  const base = mkdtempSync(join(tmpdir(), 'atomic-archive-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const remote = join(base, 'origin.git');
  const root = join(base, 'runner');
  git(base, 'init', '-q', '--bare', '-b', 'dev', remote);
  git(base, 'clone', '-q', remote, root);
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.test');
  mkdirSync(join(root, '.issues/closed'), { recursive: true });
  writeFileSync(join(root, '.issues/closed', id + '.md'), content);
  writeFileSync(join(root, '.issues/issue-numbers.json'), JSON.stringify({ version: 1, next: 2, issues: { [id]: 1 } }));
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify({ sharedIssueQueue: true, sharedIssueQueueBranch: 'issue-queue', sharedIssueQueueDirect: true })
  );
  writeFileSync(
    join(root, '.issues/issue-delivery-config.json'),
    JSON.stringify({ provider: 'github', remote: 'origin', target: 'dev', repository: 'example/timey' })
  );
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Seed queue');
  git(root, 'push', '-q', 'origin', 'dev', `HEAD:${target}`);
  const pushes = [];
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    issueChats: { tasks: new Map() },
    store: { runs: [], connected: new Map() },
  };
  const queue = createSharedIssueQueue(service, {
    pushDirect(commit, destination, claim, expectedHead) {
      pushes.push({ commit, destination, claim, expectedHead });
      behavior.before?.({ root, remote, commit, claim, pushes });
      git(
        root,
        'push',
        '--atomic',
        `--force-with-lease=${claimRef}:${claim.oid}`,
        `--force-with-lease=${destination}:${expectedHead}`,
        'origin',
        `${commit}:${destination}`,
        `:${claimRef}`
      );
      behavior.after?.({ root, remote, commit, claim, pushes });
      return behavior.receipt === false ? undefined : { commit, releasedClaim: claim };
    },
  });
  t.after(() => queue.close());
  return { root, remote, queue, pushes };
}

test('direct archive atomically publishes and forgets only its local claim', (t) => {
  const { root, remote, queue, pushes } = fixture(t);
  const result = queue.moveStorage(id, 'archive', content);
  assert.equal(result.status, 'published');
  assert.equal(pushes.length, 1);
  assert.equal(git(remote, 'rev-parse', target), pushes[0].commit);
  assert.equal(git(remote, 'for-each-ref', claimRef), '');
  assert.equal(queue.view(id).claimed, false);
  assert.equal(existsSync(join(root, '.issues/closed', id + '.md')), false);
  assert.equal(readFileSync(join(root, '.issues/archive', id + '.md'), 'utf8'), content);
  const publication = JSON.parse(readFileSync(join(root, '.issues/shared-publication', id + '.json')));
  assert.equal(publication.atomicRelease.commit, publication.commit);
  assert.equal(publication.atomicRelease.releasedClaim.oid, pushes[0].claim.oid);
  assert.equal(queue.moveStorage(id, 'archive', content), null);
});

test('atomic archive rejects a replaced claim without publishing the removal', (t) => {
  const { root, remote, queue } = fixture(t, {
    before({ remote }) {
      git(remote, 'update-ref', claimRef, git(remote, 'rev-parse', 'dev'));
    },
  });
  const before = git(remote, 'rev-parse', target);
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'failed');
  assert.equal(git(remote, 'rev-parse', target), before);
  assert.equal(git(remote, 'rev-parse', claimRef), git(remote, 'rev-parse', 'dev'));
  assert.equal(readFileSync(join(root, '.issues/closed', id + '.md'), 'utf8'), content);
  assert.equal(queue.view(id).local, true);
});

test('atomic archive preserves a replacement remote claim created after publication', (t) => {
  const { root, remote, queue } = fixture(t, {
    after({ remote }) {
      git(remote, 'update-ref', claimRef, git(remote, 'rev-parse', 'dev'));
    },
  });
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'published');
  assert.equal(git(remote, 'rev-parse', claimRef), git(remote, 'rev-parse', 'dev'));
  assert.equal(createSharedIssueClaims({ root }).own(id), null);
});

test('a lost atomic acknowledgment uses normal claim reconciliation', (t) => {
  const { root, remote, queue } = fixture(t, {
    after() {
      throw Error('The successful push response was lost.');
    },
  });
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'published');
  assert.equal(git(remote, 'for-each-ref', claimRef), '');
  assert.equal(createSharedIssueClaims({ root }).own(id), null);
  const publication = JSON.parse(readFileSync(join(root, '.issues/shared-publication', id + '.json')));
  assert.equal(publication.atomicRelease, undefined);
});

test('atomic archive retries an unrelated target change without releasing the claim early', (t) => {
  const { root, remote, queue, pushes } = fixture(t, {
    before({ root, remote, pushes }) {
      if (pushes.length !== 1) return;
      const tree = git(root, 'rev-parse', 'HEAD^{tree}');
      const commit = git(root, 'commit-tree', tree, '-p', git(remote, 'rev-parse', target), '-m', 'Other queue update');
      git(root, 'push', 'origin', `${commit}:${target}`);
    },
  });
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'published');
  assert.equal(pushes.length, 2);
  assert.notEqual(pushes[0].commit, pushes[1].commit);
  assert.equal(git(remote, 'rev-parse', target), pushes[1].commit);
  assert.equal(createSharedIssueClaims({ root }).own(id), null);
});

test('archive resumes after interruption before local cleanup using the persisted acknowledgment', (t) => {
  const { root, remote, queue } = fixture(t, {
    after({ root }) {
      writeFileSync(join(root, '.issues/archive', id + '.md'), content + 'A conflicting local edit.\n');
    },
  });
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'failed');
  assert.equal(git(remote, 'for-each-ref', claimRef), '');
  assert.ok(createSharedIssueClaims({ root }).own(id));
  writeFileSync(join(root, '.issues/archive', id + '.md'), content);
  assert.equal(queue.retry(id).status, 'published');
  assert.equal(createSharedIssueClaims({ root }).own(id), null);
  assert.equal(queue.moveStorage(id, 'archive', content), null);
});

test('the App helper acknowledges an actual atomic Git transaction without exposing its token', (t) => {
  const { root, remote } = fixture(t);
  const owner = createSharedIssueClaims({ root });
  const claim = owner.acquire(id);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const tools = join(root, 'tools');
  mkdirSync(tools);
  const wrapper = join(tools, 'git');
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('remote') && args.includes('-v')) {
  process.stdout.write('timey-queue-app\\thttps://github.com/example/timey.git (push)\\n');
} else {
  const next = args.map(a => a === 'timey-queue-app' ? process.env.ATOMIC_TEST_REMOTE : a);
  const result = cp.spawnSync(process.env.ATOMIC_TEST_GIT, next, { env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' }, encoding: 'utf8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exitCode = result.status || 0;
}
`
  );
  chmodSync(wrapper, 0o755);
  const preload = join(root, 'credentials.mjs');
  writeFileSync(
    preload,
    `import { registerHooks } from 'node:module';
registerHooks({load(url, context, next) {
  return url.endsWith('/factory-ui/github-app.mjs')
    ? {format:'module',shortCircuit:true,source:"export const githubAppCredentials=()=>({session:async()=>({token:'private-fixture-token'})});"}
    : next(url, context);
}});`
  );
  git(root, 'rm', '.issues/closed/' + id + '.md');
  git(root, 'commit', '-qm', 'Archive fixture');
  const commit = git(root, 'rev-parse', 'HEAD');
  const helper = fileURLToPath(new URL('./factory-ui/shared-issue-app-push.mjs', import.meta.url));
  const output = execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, helper], {
    cwd: root,
    env: { ...process.env, PATH: tools + ':' + process.env.PATH, ATOMIC_TEST_REMOTE: remote, ATOMIC_TEST_GIT: realGit },
    input: JSON.stringify({
      repository: 'example/timey',
      targetRef: target,
      commit,
      expectedHead: git(root, 'rev-parse', `${commit}^`),
      releaseClaim: { issueId: id, oid: claim.oid },
    }),
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), { commit, releasedClaim: { issueId: id, oid: claim.oid } });
  assert.equal(output.includes('private-fixture-token'), false);
  assert.equal(git(remote, 'rev-parse', target), commit);
  assert.equal(git(remote, 'for-each-ref', claimRef), '');
  assert.throws(
    () =>
      execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, helper], {
        cwd: root,
        env: {
          ...process.env,
          PATH: tools + ':' + process.env.PATH,
          ATOMIC_TEST_REMOTE: remote,
          ATOMIC_TEST_GIT: realGit,
        },
        input: JSON.stringify({
          repository: 'example/timey',
          targetRef: target,
          commit,
          expectedHead: commit,
          releaseClaim: { issueId: id, oid: claim.oid },
        }),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    /directly extend/
  );
  assert.equal(git(remote, 'rev-parse', target), commit);
  owner.forgetReleased(claim);
});

function traceGit(t) {
  const directory = mkdtempSync(join(tmpdir(), 'archive-batch-trace-'));
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = join(directory, 'git.trace');
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

function tracedFetches(action) {
  const path = process.env.GIT_TRACE;
  const previous = process.env.GIT_TRACE;
  const offset = existsSync(path) ? readFileSync(path, 'utf8').length : 0;
  process.env.GIT_TRACE = path;
  try {
    action();
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
  }
  return readFileSync(path, 'utf8')
    .slice(offset)
    .split('\n')
    .filter((line) => /built-in: git fetch /.test(line)).length;
}

test('a direct archive batches from its verified claim snapshot with three total fetches', (t) => {
  traceGit(t);
  const { root, queue, pushes } = fixture(t);
  const fetches = tracedFetches(() => assert.equal(queue.moveStorage(id, 'archive', content).status, 'published'));
  assert.equal(fetches, 3);
  assert.equal(pushes[0].expectedHead, git(root, 'rev-parse', `${pushes[0].commit}^`));
});

test('a target rewind rejects a stale batch even when its commit would otherwise fast-forward', (t) => {
  let original;
  let advanced;
  const { root, remote, queue, pushes } = fixture(t, {
    before({ remote, pushes, claim }) {
      if (pushes.length === 1) git(remote, 'update-ref', target, original);
      else assert.equal(git(remote, 'rev-parse', claimRef), claim.oid);
    },
  });
  original = git(remote, 'rev-parse', target);
  advanced = git(root, 'commit-tree', git(root, 'rev-parse', 'HEAD^{tree}'), '-p', original, '-m', 'Advanced queue');
  git(root, 'push', 'origin', `${advanced}:${target}`);
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'published');
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].expectedHead, advanced);
  assert.equal(pushes[1].expectedHead, original);
  assert.equal(git(remote, 'rev-parse', target), pushes[1].commit);
});

test('a changed selected report rejects the batch and retains the changed remote report', (t) => {
  let changed;
  const { root, remote, queue, pushes } = fixture(t, {
    before({ root, remote, pushes }) {
      if (pushes.length !== 1) return;
      writeFileSync(join(root, '.issues/closed', id + '.md'), content + 'Changed remotely.\n');
      git(root, 'add', '.issues/closed/' + id + '.md');
      git(root, 'commit', '-qm', 'Change selected report');
      changed = git(root, 'rev-parse', 'HEAD');
      git(root, 'push', 'origin', `${changed}:${target}`);
      writeFileSync(join(root, '.issues/closed', id + '.md'), content);
    },
  });
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'failed');
  assert.equal(pushes.length, 1);
  assert.equal(git(remote, 'rev-parse', target), changed);
  assert.match(git(remote, 'show', `${target}:.issues/closed/${id}.md`), /Changed remotely/);
  assert.equal(readFileSync(join(root, '.issues/closed', id + '.md'), 'utf8'), content);
  assert.equal(git(remote, 'rev-parse', claimRef), pushes[0].claim.oid);
});

test('an explicit archive retry fetches fresh state instead of reusing its saved batch head', (t) => {
  traceGit(t);
  const { root, queue } = fixture(t, {
    after({ root }) {
      writeFileSync(join(root, '.issues/archive', id + '.md'), content + 'Conflicting copy.\n');
    },
  });
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'failed');
  writeFileSync(join(root, '.issues/archive', id + '.md'), content);
  const fetches = tracedFetches(() => assert.equal(queue.retry(id).status, 'published'));
  assert.equal(fetches, 1);
});
