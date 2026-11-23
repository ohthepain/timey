import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshProvider, setupProvider } from './factory-ui/provider-setup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-provider-setup-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  symlinkSync('/usr/bin/git', join(bin, 'git'));
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  });
  const log = join(root, 'requests.jsonl');
  const source = `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log=${JSON.stringify(log)};
const name=process.argv[1].split('/').pop();
const args=process.argv.slice(2);
if(args[0]==='--version') { console.log('native-fixture 1'); process.exit(0); }
if(args[0]==='auth') { console.log(JSON.stringify({loggedIn:true,email:'fixture@example.invalid',authMethod:'claudeai'})); process.exit(0); }
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line), method=m.method||m.request?.subtype;
 appendFileSync(log,JSON.stringify({name,method})+'\\n');
 if(!m.id && !m.request_id) return;
 let result;
 if(method==='initialize') result=name==='claude'?{models:[{value:'claude-sonnet-test',displayName:'Claude Sonnet Test'}]}:{agentCapabilities:{loadSession:true}};
 else if(method==='account/read') result={account:{type:'chatgpt',email:'fixture@example.invalid'}};
 else if(method==='model/list') result={data:[{id:'codex-test',model:'codex-test',displayName:'Codex Test'}],nextCursor:null};
 else if(method==='account/rateLimits/read') result={rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}};
 else if(method==='session/new') result={sessionId:'12345678-1234-1234-1234-123456789abc',models:{availableModels:[{modelId:'gemini-pro-test',name:'Gemini Pro Test'}]}};
 else { process.exitCode=1; throw Error('Unexpected model or auth operation: '+method); }
 console.log(JSON.stringify(name==='claude'?{type:'control_response',response:{subtype:'success',request_id:m.request_id,response:result}}:{jsonrpc:'2.0',id:m.id,result}));
});
`;
  for (const name of ['codex', 'claude', 'gemini']) writeFileSync(join(bin, name), source, { mode: 0o700 });
  return { root, log };
}

test('native discovery lists new model identities without sending a prompt or initiating sign-in', async (t) => {
  const { root, log } = fixture(t);
  for (const id of ['codex', 'anthropic', 'google']) {
    const result = await refreshProvider(root, id);
    const provider = result.providers.find((entry) => entry.id === id);
    assert.equal(provider.ready, true, provider.message);
    const advertised = provider.models.find((entry) => entry.id.includes('test'));
    assert.ok(advertised);
    assert.equal(advertised.enabled, false);
  }
  const requests = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(requests.some((entry) => entry.method === 'account/rateLimits/read'));
  assert.ok(requests.every((entry) => !/prompt|turn|authenticate|login/.test(entry.method)));
});
test('missing native installation returns a guide and sends no model request', async (t) => {
  const { root } = fixture(t);
  rmSync(join(root, 'bin/claude'));
  const result = await setupProvider(root, 'anthropic');
  assert.match(result.message, /Install the native agent/);
  assert.match(result.guide, /^https:\/\/code.claude.com/);
  await assert.rejects(setupProvider(root, 'other'), /supported provider/);
});

test('Setup reuses an existing native sign-in without opening a terminal or sending a model prompt', async (t) => {
  const { root, log } = fixture(t);
  const result = await setupProvider(root, 'google');
  assert.equal(result.ready, true);
  assert.match(result.message, /Existing native sign-in found/);
  const requests = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(requests.every((entry) => !/prompt|turn|authenticate|login/.test(entry.method)));
});
