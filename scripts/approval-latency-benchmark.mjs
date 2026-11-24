import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
assert.ok(args.includes('--live'), 'Use --live to authorize disposable issue creation and approval.');
const url = new URL(option('--url', 'http://127.0.0.1:4317'));
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Choose a local Factory server.');
const runs = Number(option('--runs', '5'));
assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 10, 'Choose one to ten runs.');
const home = await fetch(url);
assert.equal(home.status, 200);
const cookie = home.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
assert.ok(cookie, 'Factory did not establish an authenticated session.');
const measurements = [];
const result = { cores: availableParallelism(), load: loadavg(), measurements, errors: 0 };
const output = option('--output');
function save() {
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
}
async function request(path, body) {
  const response = await fetch(new URL(path, url), {
    headers: { cookie, origin: url.origin, 'content-type': 'application/json', 'x-factory-action': 'manual' },
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.ok(!value.error, JSON.stringify(value));
  return value;
}
async function closeDisposable(view) {
  const context = await request('/api/issue-closure?issue=' + view.issue.id);
  await request('/api/issue-decision', {
    ...context,
    kind: 'close',
    flowRevision: view.flow.revision,
    resolution: 'obsolete',
    reason: 'Disposable issue 203 approval measurement completed; no implementation or acceptance requested.',
    runClosureRetro: false,
  });
  const final = await request('/api/flow?issue=' + view.issue.id);
  assert.equal(final.issue.state, 'closed', 'Dispose of the measurement issue through normal Close.');
}
try {
  const stores = await request('/api/issue-stores');
  result.coordination = stores.coordination;
  result.profile = option('--profile', 'files');
  result.providers = stores.stores.map(({ id, kind }) => ({ id, kind }));
  for (let run = 0; run < runs; run++) {
    let view = await request('/api/flow-action', {
      action: 'capture',
      requestId: randomUUID(),
      description:
        'Disposable issue 203 approval latency measurement\nCreated only to measure approval completion. No work should run.',
      type: 'bug',
      needsApproval: true,
      storageProfile: option('--profile', 'files'),
      folder: 'Inbox',
    });
    assert.equal(view.issue.state, 'needs-approval');
    const sample = { run, issueId: view.issue.id, startedAt: new Date().toISOString() };
    measurements.push(sample);
    save();
    const start = performance.now();
    view = await request('/api/flow-action', {
      action: 'approve-issue',
      issueId: view.issue.id,
      revision: view.flow.revision,
    });
    sample.ms = performance.now() - start;
    assert.equal(view.issue.state, 'backlog');
    const confirmed = await request('/api/flow?issue=' + view.issue.id + '&refresh=true');
    assert.equal(confirmed.issue.state, 'backlog');
    sample.confirmed = true;
    save();
    await closeDisposable(confirmed);
    sample.closed = true;
    save();
    console.log(JSON.stringify(sample));
  }
} catch (error) {
  result.errors++;
  result.error = error.message;
  throw error;
} finally {
  save();
}
