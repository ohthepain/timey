import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedIssueQueue } from './factory-ui/shared-issue-queue.mjs';
import { createSharedIssueClaims } from './factory-ui/shared-issue-claims.mjs';
import { createSharedIssueGit } from './factory-ui/shared-issue-git.mjs';
import { queueClaimPath } from './factory-ui/shared-issue-paths.mjs';

const id = '20261111T165430736-ca3555165563420b';
const claimPath = queueClaimPath(id);
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
  const report = behavior.investigation
    ? content.replace('state: closed', 'state: backlog\nrequest_type: investigation\nreusable: true')
    : content;
  writeFileSync(join(root, behavior.investigation ? '.issues' : '.issues/closed', id + '.md'), report);
  writeFileSync(join(root, '.issues/issue-numbers.json'), JSON.stringify({ version: 1, next: 2, issues: { [id]: 1 } }));
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify({ sharedIssueQueue: true, sharedIssueQueueBranch: 'issue-queue', sharedIssueQueueDirect: true })
  );
  writeFileSync(
    join(root, '.issues/issue-delivery-config.json'),
    JSON.stringify({ provider: 'github', remote: 'origin', target: 'dev', repository: 'example/timey' })
  );
  writeFileSync(join(root, '.gitignore'), '/.issues/**\n');
  writeFileSync(join(root, 'app.txt'), 'Source code\n');
  git(root, 'add', 'factory.config.json', '.gitignore', 'app.txt');
  git(root, 'commit', '-qm', 'Seed queue');
  git(root, 'push', '-q', 'origin', 'dev');
  const writer = createSharedIssueGit({ root });
  const seed = writer.commit(
    git(root, 'rev-parse', 'HEAD'),
    [
      [behavior.investigation ? `.issues/${id}.md` : `.issues/closed/${id}.md`, report],
      ['.issues/issue-numbers.json', readFileSync(join(root, '.issues/issue-numbers.json'), 'utf8')],
    ],
    'Seed metadata'
  );
  git(root, 'push', '-q', 'origin', `${seed}:${target}`);
  const pushes = [];
  const service = {
    root,
    lifecycleRuns: {},
    lifecycleTasks: new Map(),
    issueChats: { tasks: new Map() },
    store: { runs: [], connected: new Map() },
  };
  const queue = createSharedIssueQueue(service, {
    pushClaim: (commit, destination, _, head) =>
      git(root, 'push', `--force-with-lease=${destination}:${head}`, 'origin', `${commit}:${destination}`),
    pushDirect(commit, destination, claim, expectedHead) {
      pushes.push({ commit, destination, claim, expectedHead });
      if (!claim) {
        git(root, 'push', 'origin', `${commit}:${destination}`);
        return { commit };
      }
      behavior.before?.({ root, remote, commit, claim, pushes });
      git(root, 'push', `--force-with-lease=${destination}:${expectedHead}`, 'origin', `${commit}:${destination}`);
      behavior.after?.({ root, remote, commit, claim, pushes });
      return behavior.receipt === false ? undefined : { commit, releasedClaim: claim };
    },
  });
  t.after(() => queue.close());
  return { root, remote, queue, pushes, report };
}

test('direct archive atomically publishes and forgets only its local claim', (t) => {
  const { root, remote, queue, pushes } = fixture(t);
  const result = queue.moveStorage(id, 'archive', content);
  assert.equal(result.status, 'published');
  assert.equal(pushes.length, 1);
  assert.equal(git(remote, 'rev-parse', target), pushes[0].commit);
  assert.equal(git(remote, 'ls-tree', target, claimPath), '');
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
    before({ root }) {
      replaceClaim(root);
    },
  });
  const before = git(remote, 'rev-parse', target);
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'failed');
  assert.notEqual(git(remote, 'rev-parse', target), before);
  assert.match(git(remote, 'show', `${target}:${claimPath}`), /replacement/);
  assert.equal(git(remote, 'show', `${target}:.issues/closed/${id}.md`), content.trim());
  assert.equal(readFileSync(join(root, '.issues/closed', id + '.md'), 'utf8'), content);
  assert.equal(queue.view(id).local, true);
});

test('atomic archive preserves a replacement remote claim created after publication', (t) => {
  const { root, remote, queue } = fixture(t, {
    after({ root }) {
      replaceClaim(root);
    },
  });
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'published');
  assert.match(git(remote, 'show', `${target}:${claimPath}`), /replacement/);
  assert.equal(createSharedIssueClaims({ root }).own(id), null);
});

test('a lost atomic acknowledgment uses normal claim reconciliation', (t) => {
  const { root, remote, queue } = fixture(t, {
    after() {
      throw Error('The successful push response was lost.');
    },
  });
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'published');
  assert.equal(git(remote, 'ls-tree', target, claimPath), '');
  assert.equal(createSharedIssueClaims({ root }).own(id), null);
  const publication = JSON.parse(readFileSync(join(root, '.issues/shared-publication', id + '.json')));
  assert.equal(publication.atomicRelease.commit, publication.commit);
});

test('atomic archive retries an unrelated target change without releasing the claim early', (t) => {
  const { root, remote, queue, pushes } = fixture(t, {
    before({ root, remote, pushes }) {
      if (pushes.length !== 1) return;
      const tree = git(remote, 'rev-parse', `${target}^{tree}`);
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
  assert.equal(git(remote, 'ls-tree', target, claimPath), '');
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
  const writer = createSharedIssueGit({ root });
  const head = writer.fetch();
  const commit = writer.commit(
    head,
    [
      [`.issues/closed/${id}.md`, null],
      [claimPath, null],
    ],
    'Archive fixture'
  );
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
  assert.equal(git(remote, 'ls-tree', target, claimPath), '');
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
  writeFileSync(join(root, 'app.txt'), 'Unexpected source change.\n');
  git(root, 'add', 'app.txt');
  const unsafe = git(root, 'commit-tree', git(root, 'write-tree'), '-p', commit, '-m', 'Unexpected code');
  const blocked = (targetRef) =>
    execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, helper], {
      cwd: root,
      env: {
        ...process.env,
        PATH: tools + ':' + process.env.PATH,
        ATOMIC_TEST_REMOTE: remote,
        ATOMIC_TEST_GIT: realGit,
      },
      input: JSON.stringify({ repository: 'example/timey', targetRef, commit: unsafe, expectedHead: commit }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  assert.throws(() => blocked(target), /only change issue metadata/);
  assert.throws(() => blocked('refs/heads/dev'), /configured dedicated issue queue/);
  assert.equal(git(remote, 'rev-parse', target), commit);
  owner.forgetReleased(claim);
});

function replaceClaim(root) {
  const writer = createSharedIssueGit({ root });
  const head = writer.fetch();
  const value =
    JSON.stringify({
      version: 2,
      issueId: id,
      attemptId: 'replacement',
      runner: 'Fixture',
      remote: 'origin',
      target: 'issue-queue',
    }) + '\n';
  writer.push(writer.commit(head, [[claimPath, value]], 'Replace stopped owner'), head);
}

test('a status checkpoint and claim release leave source HEAD, index, and dirty work unchanged', (t) => {
  const { root, remote, queue, pushes } = fixture(t);
  const before = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'app.txt'), 'Staged source\n');
  git(root, 'add', 'app.txt');
  writeFileSync(join(root, 'app.txt'), 'Unstaged source\n');
  const index = git(root, 'write-tree');
  const status = git(root, 'status', '--porcelain');
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'published');
  assert.equal(pushes.length, 1);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(remote, 'rev-parse', 'dev'), before);
  assert.equal(git(root, 'write-tree'), index);
  assert.equal(git(root, 'status', '--porcelain'), status);
  assert.equal(readFileSync(join(root, 'app.txt'), 'utf8'), 'Unstaged source\n');
  assert.equal(git(remote, 'for-each-ref', 'refs/heads/claims'), '');
});

test('a changed selected report rejects publication and retains its claim', (t) => {
  let changed;
  const { root, remote, queue, pushes } = fixture(t, {
    before({ root, pushes }) {
      if (pushes.length !== 1) return;
      const writer = createSharedIssueGit({ root });
      const head = writer.fetch();
      changed = writer.commit(head, [[`.issues/closed/${id}.md`, content + 'Changed remotely.\n']], 'Change report');
      writer.push(changed, head);
    },
  });
  assert.equal(queue.moveStorage(id, 'archive', content).status, 'failed');
  assert.equal(pushes.length, 1);
  assert.equal(git(remote, 'rev-parse', target), changed);
  assert.match(git(remote, 'show', `${target}:.issues/closed/${id}.md`), /Changed remotely/);
  assert.ok(git(remote, 'ls-tree', target, claimPath));
  assert.equal(readFileSync(join(root, '.issues/closed', id + '.md'), 'utf8'), content);
});

test('a direct investigation archive removes its open report atomically without closure', (t) => {
  const { root, remote, queue, report } = fixture(t, { investigation: true });
  assert.equal(queue.moveStorage(id, 'archive', report).status, 'published');
  assert.equal(existsSync(join(root, '.issues', id + '.md')), false);
  assert.equal(readFileSync(join(root, '.issues/archive', id + '.md'), 'utf8'), report);
  assert.equal(git(remote, 'ls-tree', target, claimPath), '');
  assert.equal(git(remote, 'ls-tree', target, '.issues/closed/'), '');
  assert.equal(queue.moveStorage(id, 'restore', report).status, 'published');
  assert.equal(readFileSync(join(root, '.issues', id + '.md'), 'utf8'), report);
});
