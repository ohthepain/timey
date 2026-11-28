import { initializeProviderConfig, readProviderConfig, saveProviderEnabled } from './factory-ui/provider-config.mjs';
import { observeProvider, saveProviderSettings } from './factory-ui/provider-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeAgentConnection } from './factory-ui/native-agent.mjs';
import { chatProgress, recordChatProgress } from './factory-ui/chat-progress.mjs';
import { createIssueChatConnection, attachIssueChat } from './factory-ui/issue-chat-runtime.mjs';
import { recoverAgentSession } from './factory-ui/agent-recovery.mjs';
import { once } from 'node:events';

const fixture = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const google = process.argv.includes('--acp');
let pending, permission, session = '12345678-1234-1234-1234-123456789abc';
const mcpIndex=process.argv.indexOf('--mcp-config');
let mcp=mcpIndex<0?null:JSON.parse(process.argv[mcpIndex+1]).mcpServers.timey_chat;
let useMcp=false;
let useQuestions=false;
async function invokeMcp() {
 const headers={'content-type':'application/json',...(Array.isArray(mcp.headers)?Object.fromEntries(mcp.headers.map(h=>[h.name,h.value])):mcp.headers)};
 const initialized=await fetch(mcp.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})});
 await initialized.json();
 headers['mcp-session-id']=initialized.headers.get('mcp-session-id');
 const response=await fetch(mcp.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'record',arguments:{value:'proof'}}})});
 const result=await response.json();
 if (result.error || result.result.isError) throw Error('Tool failed');
}
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (message, result) => google ? send({jsonrpc:'2.0',id:message.id,result})
 : send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:result}});
function finish(text, stopped=false) {
 if (google) {
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
  reply(pending,{stopReason:stopped?'cancelled':'end_turn'});
 } else {
  send({type:'result',result:text,is_error:stopped});
  send({type:'system',subtype:'session_state_changed',state:'idle'});
 }
 pending=null;
}
function progress() {
 const text='[Milestone] Found the native command result.';
 if (google) {
  const update = value => send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:value}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:text.slice(0, 10)}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:text.slice(10)}});
  update({sessionUpdate:'tool_call',toolCallId:'progress-tool',title:'Read fixture',rawInput:{command:'cat result.txt'}});
  update({sessionUpdate:'tool_call_update',toolCallId:'progress-tool',status:'completed',rawOutput:'native command output'});
 } else {
  send({type:'assistant',message:{id:'comment',content:[{type:'text',text},{type:'tool_use',id:'progress-tool',name:'Bash',input:{command:'cat result.txt'}}]}});
  send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'progress-tool',content:'native command output'}]}});
 }
 return finish('Final native reply.');
}
createInterface({input:process.stdin}).on('line', async line => {
 const message=JSON.parse(line);
 const method=google?message.method:message.request?.subtype;
 if (method==='initialize') return reply(message,google?
  {agentCapabilities:{loadSession:true,mcpCapabilities:{http:true}}}:
  {models:[{value:'sonnet'},{value:'opus'}]});
 if (['session/new','session/load'].includes(method)) {
  mcp=message.params.mcpServers[0];
  return reply(message,{sessionId:session,models:{availableModels:[{modelId:'pro'},{modelId:'flash'}]}});
 }
 if (['session/set_mode','session/set_model','set_model'].includes(method)) return reply(message,{});
 if (method==='interrupt' || method==='session/cancel') {
  if (!google) reply(message,{});
  return finish('Stopped',true);
 }
 if (method==='session/prompt' || message.type==='user') {
  pending=message;
  const text=google?message.params.prompt[0].text:message.message.content;
  if (text.includes('PROGRESS')) return progress();
  if (!google) send({type:'user',message:{role:'user',content:text}});
  useMcp=text.includes('MCP');
  useQuestions=!google && text.includes('QUESTIONS');
  if (text.includes('WAIT')) {
   if (google) send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'available_commands_update',availableCommands:[]}}});
   writeFileSync(join(process.cwd(),'waiting.txt'),'Waiting');
   return;
  }
  if (useQuestions) return send({type:'control_request',request_id:'question',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'Which output?',header:'Output',options:[{label:'Summary',description:'Brief'}],multiSelect:false}]}}});
  permission=google?{jsonrpc:'2.0',id:'approval',method:'session/request_permission',params:{sessionId:session,
   toolCall:{title:'Edit a file',rawInput:{path:'result.txt'}},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}}:
   {type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'result.txt'}}};
  return send(permission);
 }
 if ((google && message.id==='approval') || (!google && message.type==='control_response')) {
  if (useQuestions) return finish(message.response.response.updatedInput.answers['Which output?']);
  const allowed=google?message.result.outcome.optionId==='yes':message.response.response.behavior==='allow';
  if (allowed && useMcp) await invokeMcp();
  if (allowed) writeFileSync(join(process.cwd(),'result.txt'),'approved edit');
  return finish(allowed?'Completed the edit':'Edit declined');
 }
});
`;

function setup(t, provider) {
  const root = mkdtempSync(join(tmpdir(), 'timey-native-test-'));
  const command = join(root, 'agent.mjs');
  writeFileSync(command, fixture);
  const events = [];
  const connection = new NativeAgentConnection({
    root,
    model: provider === 'anthropic' ? 'anthropic:sonnet' : 'google:pro',
    command: process.execPath,
    commandArgs: [command],
    onEvent: (event) => events.push(event),
  });
  t.after(() => {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, connection, events };
}

for (const provider of ['anthropic', 'google']) {
  test(`${provider} native tools retain semantic progress`, async (t) => {
    const { root, connection, events } = setup(t, provider);
    const id = await connection.start(root);
    assert.equal(await connection.turn(id, root, 'PROGRESS'), 'Final native reply.');
    const response = {};
    for (const event of events) recordChatProgress(response, event);
    const progress = chatProgress(response.chatActivity);
    assert.deepEqual(
      progress.milestones.map(({ text }) => text),
      ['Found the native command result.']
    );
    assert.deepEqual(
      progress.commands.map(({ command, output }) => ({ command, output })),
      [{ command: 'cat result.txt', output: 'native command output' }]
    );
  });
  test(`${provider} Stop before dispatch cannot send a prompt afterward`, async (t) => {
    const { root, connection } = setup(t, provider);
    const id = await connection.start(root);
    const response = connection.turn(id, root, 'Edit the fixture.');
    const rejected = assert.rejects(response, /stopped before its prompt was sent/);
    assert.deepEqual(await connection.interrupt(id), { interrupted: true });
    await rejected;
    assert.equal(connection.turns.size, 0);
    assert.equal(connection.requests.size, 0);
    assert.equal(existsSync(join(root, 'result.txt')), false);
  });
  test(`${provider} manual disable interrupts the running native turn and blocks a later prompt`, async (t) => {
    const { root, connection } = setup(t, provider);
    const { revision } = initializeProviderConfig(root);
    saveProviderEnabled(root, { provider, active: true, revision });
    const model = provider === 'anthropic' ? 'anthropic:sonnet' : 'google:pro';
    observeProvider(root, provider, { ready: true, models: [{ id: model, name: model }] });
    let config = readProviderConfig(root);
    config.providers[provider].enabled = [model];
    config.providers[provider].allowUnmonitored = true;
    saveProviderSettings(root, config);
    const id = await connection.start(root);
    const response = connection.turn(id, root, 'WAIT');
    const rejected = assert.rejects(response, /Resume explicitly/);
    await waitFor(() => existsSync(join(root, 'waiting.txt')));
    config = readProviderConfig(root);
    config.providers[provider].enabled = [];
    saveProviderSettings(root, config);
    await rejected;
    assert.equal(connection.turns.size, 0);
    await assert.rejects(connection.turn(id, root, 'Edit the fixture.'), /disabled/);
    assert.equal(existsSync(join(root, 'result.txt')), false);
  });
  test(`${provider} invokes guarded Timey tools through the active MCP bridge`, async (t) => {
    const { root, connection } = setup(t, provider);
    const calls = [];
    connection.blockTools = {
      definitions: [{ name: 'record', description: 'Retain proof', inputSchema: { type: 'object' } }],
      invoke: async (name, args) => {
        calls.push({ name, args });
        return { saved: true };
      },
    };
    const id = await connection.start(root);
    const response = connection.turn(id, root, 'Use the MCP tool.');
    await waitFor(() => connection.requests.size);
    assert.deepEqual(calls, []);
    connection.answer('approval', id, { decision: 'allow' });
    await response;
    assert.deepEqual(calls, [{ name: 'record', args: { value: 'proof' } }]);
    connection.close();
    const resumed = new NativeAgentConnection({
      ...connection.options,
      toolDefinitions: connection.blockTools.definitions,
    });
    t.after(() => resumed.close());
    resumed.toolHandler = async ({ tool, arguments: args }) => {
      calls.push({ name: tool, args });
      return { success: true, contentItems: [{ type: 'inputText', text: 'Saved.' }] };
    };
    await resumed.resume(id, root);
    const continued = resumed.turn(id, root, 'Use the MCP tool after restart.');
    await waitFor(() => resumed.requests.size);
    resumed.answer('approval', id, { decision: 'allow' });
    await continued;
    assert.equal(calls.length, 2, 'A fresh connection restores the registered tools.');
  });
  test(`${provider} edits only after approval, retains session, and resumes`, async (t) => {
    const { root, connection, events } = setup(t, provider);
    const id = await attachIssueChat(
      connection,
      root,
      {},
      () => {},
      'workspace-write',
      'Follow the project instructions.'
    );
    const result = connection.turn(id, root, 'Edit the file.');
    await waitFor(() => connection.requests.size);
    assert.equal(existsSync(join(root, 'result.txt')), false);
    connection.answer('approval', id, { decision: 'allow' });
    assert.equal(await result, 'Completed the edit');
    assert.equal(readFileSync(join(root, 'result.txt'), 'utf8'), 'approved edit');
    assert.ok(events.some(({ method }) => method === 'ui/approval'));
    assert.equal(JSON.parse(readFileSync(connection.path(id))).status, 'idle');
    connection.process.close();
    await connection.resume(id, root);
    const continued = connection.turn(id, root, 'Continue.');
    await waitFor(() => connection.requests.size);
    connection.answer('approval', id, { decision: 'decline' });
    assert.equal(await continued, 'Edit declined');
  });
  test(`${provider} rejects approval from another conversation and supports Stop`, async (t) => {
    const { root, connection } = setup(t, provider);
    const id = await connection.start(root);
    const denied = connection.turn(id, root, 'Edit.');
    await waitFor(() => connection.requests.size);
    assert.throws(() => connection.answer('approval', 'another-chat', { decision: 'allow' }), /no longer pending/);
    connection.answer('approval', id, { decision: 'decline' });
    await denied;
    assert.equal(existsSync(join(root, 'result.txt')), false);
    const stopped = connection.turn(id, root, 'WAIT');
    const rejected = assert.rejects(stopped, /stopped|could not complete/i);
    await connection.interrupt(id);
    await rejected;
    assert.equal(connection.turns.size, 0);
  });
  test(`${provider} retains uncertain work without replay and rejects unsupported input before dispatch`, async (t) => {
    const { root, connection } = setup(t, provider);
    const id = await connection.start(root);
    await assert.rejects(connection.turn(id, root, 'Edit.', {}, []), /not supported/);
    assert.equal(connection.turns.size, 0);
    const running = connection.turn(id, root, 'WAIT');
    const rejected = assert.rejects(running, /closed/);
    connection.process.close();
    await rejected;
    assert.equal(JSON.parse(readFileSync(connection.path(id))).status, 'uncertain');
    await assert.rejects(connection.resume(id, root), /explicit recovery/);
  });
}

test('native selection never replaces an existing Codex conversation', () => {
  const native = createIssueChatConnection({ root: '/tmp', model: 'anthropic:sonnet' });
  assert.ok(native instanceof NativeAgentConnection);
  assert.throws(() => createIssueChatConnection({ model: 'unknown:model' }), /Custom providers/);
});

test('Gemini metadata notifications do not claim acceptance of a pending prompt', async (t) => {
  const { root, connection } = setup(t, 'google');
  const id = await connection.start(root);
  const receipts = [];
  const response = connection.turn(id, root, 'WAIT', null, [], null, { accepted: (receipt) => receipts.push(receipt) });
  const rejected = assert.rejects(response, /stopped/);
  await waitFor(() => existsSync(join(root, 'waiting.txt')));
  assert.deepEqual(receipts, []);
  await connection.interrupt(id);
  await rejected;
});

test('Claude clarification answers use the existing question interface and stay bound to their request', async (t) => {
  const { root, connection } = setup(t, 'anthropic');
  const id = await connection.start(root);
  const response = connection.turn(id, root, 'QUESTIONS');
  await waitFor(() => connection.requests.size);
  const request = connection.requests.get('question');
  assert.equal(request.method, 'item/tool/requestUserInput');
  assert.throws(() => connection.answer('question', id, { answers: {} }), /Answer each question/);
  connection.answer('question', id, { answers: { 'question-0': 'Summary' } });
  assert.equal(await response, 'Summary');
  assert.equal(connection.requests.size, 0);
});

test('explicit recovery preserves evidence and refuses a live process group', async (t) => {
  const { root, connection } = setup(t, 'anthropic');
  const id = await connection.start(root);
  const running = connection.turn(id, root, 'WAIT');
  const rejected = assert.rejects(running, /closed/);
  assert.throws(() => recoverAgentSession(root, id, false), /explicitly confirm/);
  assert.throws(() => recoverAgentSession(root, id, true), /still present/);
  const exited = once(connection.process.child, 'exit');
  connection.process.close();
  await rejected;
  await exited;
  recoverAgentSession(root, id, true);
  const saved = JSON.parse(readFileSync(connection.path(id)));
  assert.equal(saved.status, 'idle');
  assert.equal(saved.recoveries[0].previousStatus, 'uncertain');
  assert.equal(existsSync(join(root, 'result.txt')), false, 'Recovery does not replay a prompt.');
  await connection.resume(id, root);
});

test('missing installation is actionable and a known rejected start remains retryable', async (t) => {
  const { root, connection } = setup(t, 'anthropic');
  connection.options.command = join(root, 'not-installed');
  const states = [];
  await assert.rejects(
    connection.start(root, 'workspace-write', (state) => states.push(state)),
    /not installed/
  );
  assert.equal(states.at(-1).threadId, null);
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(connection.turns.size, 0);
  connection.options.command = process.execPath;
  await connection.start(root);
});

async function waitFor(predicate) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < until, 'Timed out waiting for agent activity.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
