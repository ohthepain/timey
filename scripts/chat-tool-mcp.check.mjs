import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatToolMcp } from './factory-ui/chat-tool-mcp.mjs';

const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });

async function fixture(t, invoke = async (_name, args) => args) {
  let active = false;
  const registry = {
    definitions: [{ name: 'issue_control', description: 'Existing guarded control.', inputSchema: { type: 'object' } }],
    invoke,
  };
  const server = await createChatToolMcp({ tools: () => registry, active: () => active });
  t.after(() => server.close());
  const url = JSON.parse(server.args[1].slice(server.args[1].indexOf('=') + 1));
  const authorization = JSON.parse(server.args[3].slice(server.args[3].indexOf('=') + 1));
  const post = async (body, session, authenticated = true) => {
    const headers = { 'Content-Type': 'application/json' };
    if (authenticated) headers.Authorization = authorization;
    if (session) headers['Mcp-Session-Id'] = session;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { response, body: response.status === 200 ? await response.json() : null };
  };
  const initialize = async () => {
    const result = await post(
      rpc('initialize', 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' },
      })
    );
    assert.equal(result.body.result.serverInfo.name, 'timey-chat');
    return result.response.headers.get('mcp-session-id');
  };
  return {
    server,
    registry,
    post,
    initialize,
    activate: () => {
      active = true;
    },
    deactivate: () => {
      active = false;
    },
    url,
    authorization,
  };
}

test('native chat MCP is loopback authenticated and advertises the existing registry without starting tools', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
  });
  assert.match(f.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.match(f.server.args[1], /^mcp_servers\.timey_chat\.url=/);
  assert.match(f.server.args[3], /^mcp_servers\.timey_chat\.http_headers\.Authorization=/);
  assert.equal((await f.post(rpc(1, 'initialize'), null, false)).response.status, 401);
  const session = await f.initialize();
  const initialized = await f.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  assert.equal(initialized.response.status, 202);
  const listed = await f.post(rpc('list', 'tools/list'), session);
  assert.deepEqual(listed.body.result.tools, f.registry.definitions);
  assert.equal(calls, 0);
  const idle = await f.post(
    rpc('idle', 'tools/call', { name: 'issue_control', arguments: { action: 'play' } }),
    session
  );
  assert.equal(idle.body.error.code, -32003);
  assert.equal(calls, 0);
  const get = await fetch(f.url, { headers: { Authorization: f.authorization } });
  assert.equal(get.status, 405);
});

test('authenticated session receipts prevent duplicate commands and separate independent native sessions', async (t) => {
  const calls = [];
  const f = await fixture(t, async (name, args) => {
    calls.push({ name, args });
    return { accepted: true, n: calls.length };
  });
  f.activate();
  const firstSession = await f.initialize();
  const request = rpc('save-once', 'tools/call', {
    name: 'issue_control',
    arguments: { issueId: 'one', action: 'play' },
  });
  const first = await f.post(request, firstSession);
  const repeated = await f.post(request, firstSession);
  assert.deepEqual(repeated.body, first.body);
  const reordered = await f.post(
    rpc('save-once', 'tools/call', { arguments: { action: 'play', issueId: 'one' }, name: 'issue_control' }),
    firstSession
  );
  assert.deepEqual(reordered.body, first.body);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(first.body.result.content[0].text), { accepted: true, n: 1 });
  const changed = await f.post(
    rpc('save-once', 'tools/call', { name: 'issue_control', arguments: { issueId: 'two' } }),
    firstSession
  );
  assert.equal(changed.body.error.code, -32600);
  assert.equal(calls.length, 1);
  const secondSession = await f.initialize();
  assert.notEqual(secondSession, firstSession);
  await f.post(request, secondSession);
  assert.equal(calls.length, 2);
  f.deactivate();
  const inactive = await f.post(rpc('new-call', 'tools/call', { name: 'issue_control' }), firstSession);
  assert.equal(inactive.body.error.code, -32003);
  assert.equal(calls.length, 2);
});

test('in-flight commands reject uncertain replay and recover their exact outcome after completion', async (t) => {
  let release;
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const finish = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    started();
    await finish;
    return { saved: 'original' };
  });
  t.after(() => release());
  f.activate();
  const session = await f.initialize();
  const request = rpc(7, 'tools/call', { name: 'issue_control', arguments: { action: 'play' } });
  const original = f.post(request, session);
  await entered;
  const uncertain = await f.post(request, session);
  assert.equal(uncertain.body.error.code, -32002);
  assert.equal(calls, 1);
  release();
  const completed = await original;
  assert.deepEqual((await f.post(request, session)).body, completed.body);
  assert.equal(calls, 1);
});

test('registry guards remain authoritative and disposed MCP sessions cannot invoke tools', async (t) => {
  const f = await fixture(t, async () => {
    throw Error('Exact issue approval is required.');
  });
  f.activate();
  const session = await f.initialize();
  const request = rpc('guard', 'tools/call', { name: 'issue_control', arguments: { action: 'play' } });
  const guarded = await f.post(request, session);
  assert.equal(guarded.body.result.isError, true);
  assert.match(guarded.body.result.content[0].text, /approval is required/);
  assert.deepEqual((await f.post(request, session)).body, guarded.body);
  const removed = await fetch(f.url, {
    method: 'DELETE',
    headers: { Authorization: f.authorization, 'Mcp-Session-Id': session },
  });
  assert.equal(removed.status, 204);
  const expired = await f.post(rpc('expired', 'tools/list'), session);
  assert.equal(expired.body.error.code, -32001);
});
