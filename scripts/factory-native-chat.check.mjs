import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deliveryFixture } from './factory-workflow-fixture.mjs';
import { prepareNativeChat, bindNativeChat, nativeChatStatus } from './factory-native-chat.mjs';
import { readProgress, writeProgress } from './factory-progress.mjs';
import { FactoryUI } from './factory-test-service.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const f = deliveryFixture(t),
    root = f.queue.root,
    issueId = f.input.issueId;
  writeFileSync(
    join(root, '.issues', issueId + '.md'),
    `---\nid: ${issueId}\nstate: verify\n---\n# Handoff test\n\nDiscuss this disposable issue only.\n`
  );
  return { ...f, root, issueId, prepare: () => prepareNativeChat(root, { issueId, mode: 'discuss' }) };
}
test('inspection starts nothing; only explicit discussion reserves a native draft', (t) => {
  const f = fixture(t);
  assert.deepEqual(nativeChatStatus(f.root, f.issueId), { status: 'none' });
  assert.equal(readProgress(f.root)[f.issueId], undefined);
  assert.throws(() => prepareNativeChat(f.root, { issueId: f.issueId, mode: 'work' }), /discussion only/);
  const first = f.prepare(),
    url = new URL(first.href);
  assert.equal(url.protocol, 'codex:');
  assert.equal(url.searchParams.get('path'), realpathSync(f.root));
  assert.match(url.searchParams.get('prompt'), /discussion only/);
  assert.ok(url.searchParams.get('prompt').includes(first.requestId));
  assert.equal(f.prepare().href, undefined);
  assert.equal(f.prepare().requestId, first.requestId);
});
test('registration persists identity and other progress without needing HTTP; replacements reject', (t) => {
  const f = fixture(t);
  writeProgress(f.root, { issueId: f.issueId, plan: { outcome: 'Preserve me' } });
  const first = f.prepare();
  assert.throws(() => bindNativeChat(f.root, f.issueId, 'wrong', threadId), /does not match/);
  const registered = bindNativeChat(f.root, f.issueId, first.requestId, threadId);
  assert.equal(registered.href, `codex://threads/${threadId}`);
  assert.deepEqual(bindNativeChat(f.root, f.issueId, first.requestId, threadId), registered);
  assert.deepEqual(f.prepare(), registered);
  assert.equal(readProgress(f.root)[f.issueId].plan.outcome, 'Preserve me');
  assert.throws(() => bindNativeChat(f.root, f.issueId, first.requestId, threadId.replace(/^1/, '2')), /another chat/);
  const output = execFileSync(process.execPath, ['scripts/factory-native-chat.mjs', 'status', f.root, f.issueId], {
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(output).threadId, threadId);
});
test('stale reports, legacy chats, title-only issues, unknown locks and corrupt bindings do not create replacements', (t) => {
  const f = fixture(t),
    path = join(f.root, '.issues', f.issueId + '.md');
  const first = f.prepare();
  writeFileSync(path, readFileSync(path, 'utf8') + '\nChanged requirements\n');
  assert.throws(() => bindNativeChat(f.root, f.issueId, first.requestId, threadId), /issue changed/);
  assert.equal(f.prepare().href, undefined);
  writeProgress(f.root, { issueId: f.issueId, workThreadId: threadId });
  assert.throws(f.prepare, /existing work or chats/);
  writeProgress(f.root, { issueId: f.issueId });
  writeFileSync(path, `---\nid: ${f.issueId}\nstate: verify\n---\n# Only a title\n`);
  assert.throws(f.prepare, /title alone/);
  writeProgress(f.root, { issueId: f.issueId, nativeChat: { version: 8 } });
  assert.throws(f.prepare, /reconciliation/);
  const lock = join(f.root, '.issues/factory-progress-record.lock');
  mkdirSync(lock);
  assert.throws(f.prepare, /EEXIST/);
  rmSync(lock, { recursive: true });
});
test('a native chat cannot become the home of two issues', (t) => {
  const f = fixture(t),
    first = f.prepare();
  bindNativeChat(f.root, f.issueId, first.requestId, threadId);
  const other = '20261025-two';
  writeFileSync(
    join(f.root, '.issues', other + '.md'),
    `---\nid: ${other}\nstate: verify\n---\n# Other issue\n\nSeparate discussion.\n`
  );
  const pending = prepareNativeChat(f.root, { issueId: other, mode: 'discuss' });
  assert.throws(() => bindNativeChat(f.root, other, pending.requestId, threadId), /another issue/);
  assert.equal(nativeChatStatus(f.root, other).status, 'pending');
});
test('factory proof page reserves without model calls; refresh only reads and bound links reopen exactly', async (t) => {
  const f = fixture(t),
    service = new FactoryUI(f.root);
  service.codex.ready = () => {
    throw Error('No model transport allowed in this test');
  };
  const server = createFactoryServer(service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/native-chat?issue=${f.issueId}`),
    cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(await page.text(), /native-chat-ui.js/);
  assert.equal(readProgress(f.root)[f.issueId], undefined);
  const prepare = () =>
    fetch(base + '/api/native-chat-prepare', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: base,
        'Content-Type': 'application/json',
        'X-Factory-Action': 'manual',
      },
      body: JSON.stringify({ issueId: f.issueId, mode: 'discuss' }),
    }).then((r) => r.json());
  const results = await Promise.all([prepare(), prepare()]);
  assert.equal(results.filter((r) => r.href).length, 1);
  assert.equal(results[0].requestId, results[1].requestId);
  bindNativeChat(f.root, f.issueId, results[0].requestId, threadId);
  const status = await (
    await fetch(`${base}/api/native-chat?issue=${f.issueId}`, { headers: { Cookie: cookie } })
  ).json();
  assert.equal(status.href, `codex://threads/${threadId}`);
  assert.equal(service.codex.child, undefined);
});
