import test from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { captureFixture } from './factory-capture-fixture.mjs';
import { startFactoryHttp } from './factory-http-fixture.mjs';
import { createChatToolMcp } from './factory-ui/chat-tool-mcp.mjs';
import { annotationTools, issueAnnotations } from './factory-ui/issue-annotations.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';

const issueId = '20261025-existing';

async function rpcClient(t, tools) {
  const mcp = await createChatToolMcp({ tools, active: () => true });
  t.after(() => mcp.close());
  let session;
  let id = 0;
  async function rpc(method, params, headers = mcp.config.headers) {
    const response = await fetch(mcp.config.url, {
      method: 'POST',
      headers: { ...headers, ...(session && { 'Mcp-Session-Id': session }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (!response.ok) return { status: response.status };
    session = response.headers.get('mcp-session-id');
    return (await response.json()).result;
  }
  assert.equal((await rpc('initialize', {}, {})).status, 401);
  assert.ok(await rpc('initialize'));
  return {
    list: () => rpc('tools/list'),
    async call(args, name = 'issue_annotation') {
      const result = await rpc('tools/call', { name, arguments: args });
      if (result.isError) throw Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    },
  };
}

test('a scoped caller can annotate and clear other authors without changing any issue or coordination state', async (t) => {
  const { root, service } = captureFixture(t);
  const stores = await ensureProjectStores(service, { fresh: true });
  const { url, cookie } = await startFactoryHttp(t, service);
  const operator = { kind: 'user', id: userInfo().username };
  const chat = { kind: 'chat', id: 'reporting-chat' };
  const issue = { kind: 'issue', id: 'dependent-issue' };
  const scoped = await rpcClient(t, annotationTools(service, chat));
  const other = await rpcClient(t, annotationTools(service, issue));
  const before = await stores.readIssue(issueId);
  const initialClaims = await stores.coordination.list('claims/');

  const operatorNote = 'The provider was unavailable.';
  const response = await fetch(url + '/api/issue-annotation', {
    method: 'POST',
    headers: { cookie, origin: url, 'content-type': 'application/json', 'x-factory-action': 'manual' },
    body: JSON.stringify({ action: 'add', issueId, type: 'label', label: 'blocked', note: operatorNote }),
  });
  const fromOperator = await response.json();
  assert.equal(response.status, 200, JSON.stringify(fromOperator));
  assert.deepEqual(fromOperator.author, operator);

  assert.deepEqual(
    (await scoped.list()).tools.map(({ name }) => name),
    ['issue_annotation']
  );
  const block = await scoped.call({ action: 'add', issueId, type: 'label', label: 'blocked', note: 'Still blocked.' });
  const comment = await scoped.call({
    action: 'add',
    issueId,
    type: 'comment',
    text: 'Keep investigating.',
    relatedIssueId: issue.id,
  });
  assert.deepEqual(block.author, chat);
  assert.equal(comment.relatedIssueId, issue.id);
  assert.equal(comment.text, 'Keep investigating.');

  for (const action of ['folder-detach', 'approve-issue', 'edit-request', 'play']) {
    await assert.rejects(scoped.call({ action, issueId }), /Invalid input/);
    await assert.rejects(scoped.call({ action, issueId }, 'issue_control'), /registered annotation tool/);
  }
  await assert.rejects(
    scoped.call({ action: 'add', issueId, type: 'comment', text: 'Forged', author: operator }),
    /Invalid input|Unrecognized key/
  );
  const firstClear = await scoped.call({ action: 'clear', issueId, annotationId: fromOperator.id });
  assert.deepEqual(firstClear, { ...fromOperator, cleared: { at: firstClear.cleared.at, by: chat } });
  assert.ok(Number.isFinite(Date.parse(firstClear.cleared.at)));
  assert.deepEqual(await other.call({ action: 'clear', issueId, annotationId: fromOperator.id }), firstClear);

  const clearRemaining = { action: 'clear', issueId, annotationId: block.id };
  const [left, right] = await Promise.all([scoped.call(clearRemaining), other.call(clearRemaining)]);
  assert.deepEqual(left, right);
  assert.deepEqual({ ...left, cleared: undefined }, { ...block, cleared: undefined });
  const history = await issueAnnotations({ root, projectStores: stores }).list(issueId);
  assert.deepEqual(
    new Map(history.map((annotation) => [annotation.id, annotation])),
    new Map([
      [firstClear.id, firstClear],
      [left.id, left],
      [comment.id, comment],
    ])
  );
  assert.deepEqual(await stores.coordination.list('claims/'), initialClaims);
  assert.deepEqual(await stores.readIssue(issueId), before);
});
