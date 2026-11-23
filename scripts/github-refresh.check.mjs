import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureFixture } from './factory-capture-fixture.mjs';
import { startFactoryHttp } from './factory-http-fixture.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { createFlowObserver } from './factory-ui/flow-observer.mjs';

test('idle HTTP views retain GitHub state; Refresh and edits read current facts', async (t) => {
  const { root, service } = captureFixture(t);
  const stores = await ensureProjectStores(service, { fresh: true });
  const config = { provider: 'github', repository: 'fixture/repo', remote: 'origin', target: 'dev' };
  writeFileSync(join(root, '.issues/issue-delivery-config.json'), JSON.stringify(config));
  let reads = 0,
    failing = false,
    merged = false;
  const provider = {
    config,
    async inspect(number) {
      reads++;
      if (failing) throw Error('GitHub unavailable');
      return {
        number,
        html_url: `https://github.com/fixture/repo/pull/${number}`,
        title: 'Saved title',
        head: { sha: 'candidate', repo: { full_name: config.repository } },
        base: { ref: 'dev', repo: { full_name: config.repository } },
        merged_at: merged ? '2026-11-23T10:00:00Z' : null,
        merge_commit_sha: merged ? 'merged-candidate' : null,
      };
    },
  };
  service.flows = createIssueFlows(service, { deliveryOptions: { provider } });
  const id = '20261025-existing';
  const flow = service.flows.read(service.flows.selected(id));
  flow.destination = { branch: 'dev', pr: 42 };
  await service.flows.store.save(flow, flow.revision);
  const { url, cookie } = await startFactoryHttp(t, service);
  const get = async (path) => {
    const response = await fetch(url + path, { headers: { cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const endpoint = '/api/flow?issue=' + id;
  const initial = await get(endpoint);
  assert.equal(initial.environment.pr.title, 'Saved title');
  assert.equal(reads, 1);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 86_400_000);
  const refresh = stores.refresh.bind(stores);
  let synchronizations = 0;
  stores.refresh = async (...args) => {
    synchronizations++;
    return refresh(...args);
  };
  for (const path of [endpoint, '/api/flow', '/api/project-home', endpoint, '/api/issue-closure?issue=' + id])
    await get(path);
  assert.equal(reads, 1, 'Idle view and navigation performed another GitHub read.');
  assert.equal(synchronizations, 0, 'Display reads synchronized shared storage.');

  failing = true;
  const failed = await get(endpoint + '&refresh=true');
  assert.equal(reads, 2);
  assert.equal(synchronizations, 1);
  assert.equal(failed.environment.pr.title, 'Saved title');
  assert.equal(failed.environment.remoteObservedAt, initial.environment.remoteObservedAt);
  assert.match(failed.environment.remoteError, /GitHub unavailable/);
  for (let i = 0; i < 3; i++) await get(endpoint);
  assert.equal(reads, 2, 'A failed refresh restarted background retries.');
  service.flows.observer = createFlowObserver(service, { provider });
  const reopened = await get(endpoint);
  assert.equal(reads, 2, 'Reopening an observer ignored its retained observation.');
  assert.match(reopened.environment.remoteError, /GitHub unavailable/);

  failing = false;
  const recovered = await get(endpoint + '&refresh=true');
  assert.equal(reads, 3);
  assert.equal(recovered.environment.remoteError, undefined);
  merged = true;
  const response = await fetch(url + '/api/flow-action', {
    method: 'POST',
    headers: { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' },
    body: JSON.stringify({
      action: 'rename-issue',
      issueId: id,
      revision: recovered.flow.revision,
      previousTitle: recovered.issue.title,
      title: 'Must not change',
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /merged.*read.only/i);
  assert.equal(reads, 4, 'Editing trusted the saved PR observation.');
  assert.equal(service.flows.selected(id).title, recovered.issue.title);
  await get(endpoint);
  assert.equal(reads, 4, 'A retained merge caused another passive GitHub read.');
});
