import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexConnection } from './factory-ui/codex.mjs';
import { createIssueChatConnection } from './factory-ui/issue-chat-runtime.mjs';
import { sharedIssueChatBinding, sharedChatTools } from './factory-ui/shared-chat-tools.mjs';
import { createProjectDiscussTools } from './factory-ui/project-discuss-tools.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-shared-chat-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const captures = [];
  const permissions = [];
  const service = {
    root,
    ownServer() {},
    serverControl: {
      allow(path) {
        permissions.push(path);
      },
    },
    flows: {
      async capture(input) {
        captures.push(input);
        return { issue: { id: 'created-issue' } };
      },
    },
  };
  const state = {};
  const retain = (patch) => Object.assign(state, patch);
  return { root, service, captures, permissions, state, retain };
}
async function rpc(url, secret, value, session) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: secret,
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...value }),
  });
  return { value: await response.json(), session: response.headers.get('mcp-session-id') };
}
function configuredMcp(args) {
  const value = (name) => JSON.parse(args.find((entry) => entry.startsWith(name + '=')).slice(name.length + 1));
  return {
    url: value('mcp_servers.timey_chat.url'),
    secret: value('mcp_servers.timey_chat.http_headers.Authorization'),
  };
}

test('Classic native startup configures the same guarded tools without starting a model turn', async (t) => {
  const f = fixture(t);
  const executable = join(f.root, 'codex-fixture.mjs');
  const recorded = join(f.root, 'startup-args.json');
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nimport {createInterface} from 'node:readline';\nwriteFileSync(${JSON.stringify(recorded)},JSON.stringify(process.argv.slice(2)));\ncreateInterface({input:process.stdin}).on('line',(line)=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});\n`
  );
  chmodSync(executable, 0o700);
  const connection = new CodexConnection({ command: executable, mcpTools: () => sharedChatTools(f.service) });
  t.after(() => connection.close());
  await connection.ready();
  const args = JSON.parse(readFileSync(recorded, 'utf8'));
  assert.ok(args.indexOf('-c') < args.indexOf('app-server'), 'MCP overrides precede app-server startup.');
  const { url, secret } = configuredMcp(args);
  const initialized = await rpc(url, secret, {
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26' },
  });
  const session = initialized.session;
  const listed = await rpc(url, secret, { id: 2, method: 'tools/list' }, session);
  assert.deepEqual(
    listed.value.result.tools.map(({ name }) => name),
    createProjectDiscussTools(f.service).definitions.map(({ name }) => name)
  );
  const call = {
    id: 3,
    method: 'tools/call',
    params: {
      name: 'issue_create',
      arguments: { description: 'Explicitly requested work.', requestId: 'stable-capture' },
    },
  };
  const inactive = await rpc(url, secret, call, session);
  assert.equal(inactive.value.error.code, -32003);
  assert.equal(f.captures.length, 0, 'Idle native connections cannot invoke operations.');
  connection.turns.set('original-native-thread', {});
  const result = await rpc(url, secret, { ...call, id: 4 }, session);
  assert.equal(result.value.result.isError, undefined);
  assert.equal(f.captures.length, 1);
  assert.deepEqual(f.permissions, ['/api/flow-action']);
  await rpc(url, secret, { ...call, id: 4 }, session);
  assert.equal(f.captures.length, 1, 'A repeated native MCP request reuses its retained receipt.');
  connection.turns.clear();
  await connection.closeChatTools();
  await assert.rejects(() => fetch(url));
});

test('existing native issue thread identity is preserved while the same registry is exposed through MCP', async (t) => {
  const f = fixture(t);
  f.state.threadId = 'original-native-thread';
  f.state.sharedToolsUnavailable = 'Earlier unsupported capability message';
  const binding = sharedIssueChatBinding(f.service, f.state, f.retain);
  assert.ok(binding.tools.definitions.some(({ name }) => name === 'issue_create'));
  assert.equal(f.state.sharedToolsUnavailable, null);
  const connection = createIssueChatConnection({ mcpTools: () => sharedChatTools(f.service) });
  const resumes = [];
  connection.resume = async (...args) => resumes.push(args);
  connection.call = async () => ({ thread: { status: { type: 'idle' } } });
  connection.start = async () => assert.fail('An existing native conversation must never be replaced.');
  const id = await connection.attach(f.root, f.state, f.retain, 'read-only', binding.instructions);
  assert.equal(id, 'original-native-thread');
  assert.equal(f.state.threadId, 'original-native-thread');
  assert.equal(resumes[0][0], 'original-native-thread');
  assert.equal(connection.blockTools, undefined, 'Classic uses one MCP registry without duplicate dynamic tools.');
});

test('shared Classic tools retain project preview mutation guards', async (t) => {
  const f = fixture(t);
  f.service.reviewMode = 'preview';
  await assert.rejects(
    () => sharedChatTools(f.service).invoke('issue_create', { description: 'Must remain blocked.' }),
    /preview cannot change/
  );
  assert.equal(f.captures.length, 0);
});
