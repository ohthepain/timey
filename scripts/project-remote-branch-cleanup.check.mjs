import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRemoteBranchCleanup } from './factory-ui/project-remote-branch-cleanup.mjs';

const repository = 'example/factory';
const revision = 'a'.repeat(40);
const older = 'b'.repeat(40);
const different = 'c'.repeat(40);
const endpoint = `repos/${repository}`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-remote-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.issues'));
  writeFileSync(
    join(root, '.issues/issue-delivery-config.json'),
    JSON.stringify({ provider: 'github', repository, target: 'delivery', remote: 'origin' })
  );
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify({ sharedIssueQueue: true, sharedIssueQueueBranch: 'queue' })
  );
  const branches = new Map(
    Object.entries({
      delivery: revision,
      trunk: older,
      queue: older,
      'ready/first': older,
      'ready/second': older,
      changed: older,
      'new-pr': older,
      'new-protection': older,
      unmerged: different,
      'protected-rule': older,
      'pr-base': older,
      'pr-head': older,
      'fork-pr-head': older,
    })
  );
  const protectedNames = new Set(['protected-rule']);
  const openBase = new Set(['pr-base']);
  const openHead = new Set(['pr-head']);
  const associated = new Set(['fork-pr-head']);
  const mutations = [];
  const state = { unconfirmed: false };
  const provider = { gh };
  const cleanup = new ProjectRemoteBranchCleanup({ root, ownServer() {} }, { provider: () => provider });
  const branchRow = ([name, sha]) => ({ name, commit: { sha }, protected: protectedNames.has(name) });
  const ref = (name) => ({ ref: name, repo: { full_name: repository } });
  const pull = (base, head) => ({ state: 'open', base: ref(base), head: ref(head) });

  async function gh(args) {
    const path = args[3];
    if (path === endpoint)
      return JSON.stringify({ node_id: 'repository-id', full_name: repository, default_branch: 'trunk' });
    if (path === `${endpoint}/branches?per_page=100`)
      return JSON.stringify([[...branches].slice(0, 5).map(branchRow), [...branches].slice(5).map(branchRow)]);
    if (path === `${endpoint}/branches?protected=true&per_page=100`)
      return JSON.stringify([[...branches].filter(([name]) => protectedNames.has(name)).map(branchRow)]);
    if (path === `${endpoint}/pulls?state=open&per_page=100`)
      return JSON.stringify([
        [...openBase].map((base) => pull(base, 'other')),
        [...openHead].map((branch) => pull('delivery', branch)),
      ]);
    if (path.startsWith(`${endpoint}/compare/`)) {
      const merged = path.includes(`${older}...${revision}`);
      return JSON.stringify({ status: merged ? 'ahead' : 'diverged', behind_by: merged ? 0 : 1 });
    }
    assert.equal(path, 'graphql');
    const query = args[5];
    if (query.startsWith('query=' + 'query')) {
      const repo = { id: 'repository-id' };
      for (const [, alias, branch] of query.matchAll(/(b\d+): ref\(qualifiedName: "refs\/heads\/([^\"]+)"/g)) {
        repo[alias] = {
          target: { oid: branches.get(branch) },
          associatedPullRequests: { totalCount: Number(associated.has(branch)) },
          rules: { totalCount: Number(protectedNames.has(branch)) },
        };
      }
      return JSON.stringify({ data: { repository: repo } });
    }
    mutations.push(query);
    if (state.unconfirmed) throw Error('Connection lost');
    const id = query.match(/clientMutationId: "([^"]+)"/)[1];
    return JSON.stringify({ data: { updateRefs: { clientMutationId: id } } });
  }

  return { cleanup, branches, protectedNames, openBase, associated, mutations, state };
}

test('remote cleanup protects both PR sides, GitHub rules, and project branches, and rechecks the confirmed batch', async (t) => {
  const f = fixture(t);
  const preview = await f.cleanup.preview();
  const entries = new Map(preview.entries.map((entry) => [entry.name, entry.reason]));
  for (const name of ['delivery', 'trunk', 'queue']) assert.match(entries.get(name), /Kept/);
  assert.match(entries.get('protected-rule'), /Protected/);
  for (const name of ['pr-base', 'pr-head', 'fork-pr-head']) assert.match(entries.get(name), /open pull request/);
  assert.match(entries.get('unmerged'), /outside/);
  assert.equal(entries.get('ready/first'), null);
  assert.deepEqual(f.mutations, []);

  await assert.rejects(f.cleanup.apply({ id: preview.id, selected: ['protected-rule'] }), /cannot be deleted/);
  f.branches.set('changed', different);
  f.associated.add('new-pr');
  f.protectedNames.add('new-protection');
  const selected = ['ready/first', 'ready/second', 'changed', 'new-pr', 'new-protection'];
  const { results } = await f.cleanup.apply({ id: preview.id, selected });
  assert.deepEqual(
    results.map(({ name, status }) => [name, status]),
    selected.map((name, i) => [name, i < 2 ? 'deleted' : 'kept'])
  );
  assert.equal(f.mutations.length, 1);
  for (const branch of selected.slice(0, 2))
    assert.ok(
      f.mutations[0].includes(`name: "refs/heads/${branch}", beforeOid: "${older}", afterOid: "${'0'.repeat(40)}"`)
    );
  for (const branch of selected.slice(2)) assert.ok(!f.mutations[0].includes(`refs/heads/${branch}`));
  await assert.rejects(f.cleanup.apply({ id: preview.id, selected }), /fresh remote branch preview/);
});

test('a moved target and an uncertain deletion never trigger an automatic mutation retry', async (t) => {
  const f = fixture(t);
  const preview = await f.cleanup.preview();
  const selected = ['ready/first'];
  f.branches.set('delivery', different);
  await assert.rejects(f.cleanup.apply({ id: preview.id, selected }), /delivery branch changed/);
  assert.deepEqual(f.mutations, []);

  f.branches.set('delivery', revision);
  const fresh = await f.cleanup.preview();
  f.state.unconfirmed = true;
  const { results } = await f.cleanup.apply({ id: fresh.id, selected });
  assert.equal(results[0].status, 'unconfirmed');
  await assert.rejects(f.cleanup.apply({ id: fresh.id, selected }), /fresh remote branch preview/);
  assert.equal(f.mutations.length, 1);
});
