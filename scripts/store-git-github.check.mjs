import test from 'node:test';
import assert from 'node:assert/strict';
import { publishGitHubMetadata, githubMetadataHead } from './factory-ui/stores/providers/git-github.mjs';
import { gitCommitIdentity } from './factory-ui/stores/providers/git-tree.mjs';
import { gitFixture } from './git-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fixture(result = { data: { updateRefs: { clientMutationId: 'b'.repeat(40) } } }) {
  const calls = [];
  const input = {
    repository: 'owner/project',
    branch: 'queue',
    head: 'a'.repeat(40),
    identity: {
      oid: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      baseTree: 'd'.repeat(40),
      message: 'Update Factory store records\n',
      author: { name: 'Factory', email: 'factory@timey.invalid', date: '2026-11-23T00:00:00+00:00' },
      committer: { name: 'Factory', email: 'factory@timey.invalid', date: '2026-11-23T00:00:00+00:00' },
    },
    changes: [
      ['.issues/records/one.json', { text: 'Åäö' }],
      ['.issues/records/old.json', null],
    ],
    credentials: {
      session: async () => ({ token: 'fixture-token', permissions: { contents: 'write' } }),
      request: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/git/trees')) return Response.json({ sha: 'c'.repeat(40) });
        if (url.endsWith('/git/commits')) return Response.json({ sha: 'b'.repeat(40) });
        if (url.endsWith('/repos/owner/project'))
          return Response.json({ full_name: 'owner/project', node_id: 'repo-node' });
        return Response.json(result);
      },
    },
  };
  return { calls, input };
}

test('GitHub metadata publication preserves prepared objects and binds the ref update to the exact head', async () => {
  const { calls, input } = fixture();
  await publishGitHubMetadata(input);
  assert.equal(calls.length, 4);
  const tree = JSON.parse(calls[1].options.body);
  assert.equal(tree.base_tree, input.identity.baseTree);
  assert.deepEqual(JSON.parse(tree.tree[0].content), { text: 'Åäö' });
  assert.equal(tree.tree[1].sha, null);
  const commit = JSON.parse(calls[2].options.body);
  assert.deepEqual(commit.parents, [input.head]);
  assert.equal(commit.tree, input.identity.tree);
  assert.equal(commit.message, input.identity.message);
  assert.deepEqual(commit.author, input.identity.author);
  assert.deepEqual(commit.committer, input.identity.committer);
  const update = JSON.parse(calls[3].options.body).variables.input;
  assert.deepEqual(update.refUpdates, [
    { name: 'refs/heads/queue', beforeOid: input.head, afterOid: input.identity.oid, force: false },
  ]);
  assert.equal(update.repositoryId, 'repo-node');
  assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer fixture-token'));
});

test('GitHub metadata publication rejects stale heads and unconfirmed responses', async () => {
  const stale = fixture({ errors: [{ type: 'STALE_DATA', message: 'private response' }] });
  await assert.rejects(publishGitHubMetadata(stale.input), { code: 'STORE_CONFLICT' });
  const missing = fixture({ errors: [{ message: 'private response' }] });
  await assert.rejects(
    publishGitHubMetadata(missing.input),
    (error) => error.code === 'STORE_UNAVAILABLE' && !error.message.includes('private response')
  );
});

test('GitHub metadata publication stops before updating refs if object identities differ', async () => {
  const f = fixture();
  f.input.identity.tree = 'e'.repeat(40);
  await assert.rejects(publishGitHubMetadata(f.input), /differs from its prepared Git object/);
  assert.equal(f.calls.length, 2);
});

test('GitHub metadata publication preserves App permissions and rejects malformed replies', async () => {
  const f = fixture();
  f.input.credentials.session = async () => ({ permissions: { contents: 'read' } });
  await assert.rejects(publishGitHubMetadata(f.input), /Contents write/);
  assert.equal(f.calls.length, 0);
  const malformed = fixture();
  malformed.input.credentials.request = async () => new Response('private response');
  await assert.rejects(publishGitHubMetadata(malformed.input), { code: 'STORE_UNAVAILABLE' });
});

test('GitHub metadata reads require the exact branch and treat only a missing ref as absent', async () => {
  const f = fixture({ ref: 'refs/heads/queue', object: { type: 'commit', sha: 'a'.repeat(40) } });
  assert.equal(await githubMetadataHead(f.input), f.input.head);
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/owner/project/git/ref/heads/queue');
  f.input.credentials.request = async () => new Response('', { status: 404 });
  assert.equal(await githubMetadataHead(f.input), null);
  f.input.credentials.request = async () => new Response('', { status: 403 });
  await assert.rejects(githubMetadataHead(f.input), { code: 'STORE_PERMISSION' });
  f.input.credentials.request = async () =>
    Response.json({ ref: 'refs/heads/other', object: { type: 'commit', sha: f.input.head } });
  await assert.rejects(githubMetadataHead(f.input), /another branch/);
});

test('prepared metadata identity retains the exact message, tree, author and committer', async (t) => {
  const f = gitFixture(t, 'metadata-identity-');
  writeFileSync(join(f.root, 'one'), 'one');
  f.git('add', '.');
  f.git('commit', '-qm', 'Base');
  const base = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'one'), 'two');
  f.git('commit', '-am', 'Update Factory store records');
  const commit = f.git('rev-parse', 'HEAD');
  const identity = await gitCommitIdentity(
    async (args) => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8' }),
    base,
    commit
  );
  assert.equal(identity.message, 'Update Factory store records\n');
  assert.equal(identity.tree, f.git('rev-parse', 'HEAD^{tree}'));
  assert.equal(identity.baseTree, f.git('rev-parse', base + '^{tree}'));
  assert.equal(identity.author.email, 'fixture@example.invalid');
  assert.equal(identity.committer.date, f.git('show', '-s', '--format=%cI'));
});
