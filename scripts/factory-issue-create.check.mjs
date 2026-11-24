import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureFixture } from './factory-capture-fixture.mjs';
import { startFactoryHttp } from './factory-http-fixture.mjs';
import { createIssueFlows } from './factory-ui/flow-service.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { runCommand } from './factory.mjs';

function idleFlows(service) {
  return createIssueFlows(service, {
    observer: {
      async observe() {
        return {};
      },
    },
    executor: {
      async run() {
        assert.fail('Creation must not start issue execution.');
      },
      close() {},
    },
  });
}

test('external chat creation persists an idle issue and survives server replacement and request replay', async (t) => {
  const f = captureFixture(t);
  f.git('branch', 'dev');
  f.service.flows = idleFlows(f.service);
  const first = await startFactoryHttp(t, f.service);
  const input = {
    requestId: randomUUID(),
    description: 'Preserve agreed chat context\n\n## Acceptance criteria\nResume this work from Timey after restart.',
    type: 'feature',
  };
  const path = join(f.root, 'creation-request.json');
  writeFileSync(path, JSON.stringify(input));
  const create = (url) => runCommand(f.root, ['--', 'issue-create', path, '--url', url]);
  const receipt = await create(first.url);
  assert.equal(receipt.started, false);
  assert.ok(receipt.url.endsWith('/?issue=' + receipt.issueId));
  f.service.close();
  const replacement = new FactoryUI(f.root);
  t.after(() => replacement.close());
  replacement.flows = idleFlows(replacement);
  const second = await startFactoryHttp(t, replacement);
  const replay = await create(second.url);
  assert.equal(replay.issueId, receipt.issueId);
  const view = await replacement.flows.view(receipt.issueId);
  assert.equal(
    view.flow.blocks.every((block) => block.attempts.length === 0),
    true
  );
  assert.equal(view.flow.captureId, input.requestId);
  assert.match(replacement.flows.selected(receipt.issueId).content, /Resume this work from Timey after restart/);
  writeFileSync(path, JSON.stringify({ ...input, description: 'Changed request' }));
  await assert.rejects(create(second.url), /different|changed|wording|request/i);
});

test('external chat creation rejects another project, preview servers and execution fields', async (t) => {
  const f = captureFixture(t);
  f.git('branch', 'dev');
  f.service.flows = idleFlows(f.service);
  const server = await startFactoryHttp(t, f.service);
  const path = join(f.root, 'creation-request.json');
  const input = { requestId: randomUUID(), description: 'Create only' };
  writeFileSync(path, JSON.stringify(input));
  await assert.rejects(runCommand(process.cwd(), ['issue-create', path, '--url', server.url]), /another project/);
  f.service.reviewMode = 'preview';
  await assert.rejects(runCommand(f.root, ['issue-create', path, '--url', server.url]), /live Factory|preview copy/);
  writeFileSync(path, JSON.stringify({ ...input, action: 'play' }));
  await assert.rejects(runCommand(f.root, ['issue-create', path, '--url', server.url]), /Unrecognized/);
  assert.match(await runCommand(f.root, ['--', 'issue-create', '--help']), /idle issue/);
});
