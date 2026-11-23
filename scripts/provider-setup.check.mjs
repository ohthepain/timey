import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshProvider, setupProvider, installProvider } from './factory-ui/provider-setup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-provider-setup-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  symlinkSync('/usr/bin/git', join(bin, 'git'));
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
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
  assert.equal(result.setup.step, 'install');
  assert.equal(result.setup.command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.match(result.message, /Claude Code/);
  const saved = await refreshProvider(root, 'anthropic');
  assert.equal(saved.providers.find((provider) => provider.id === 'anthropic').setup.command, result.setup.command);
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

test('a CLI that exists but fails to start is not reported as missing', async (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'bin/claude'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const result = await setupProvider(root, 'anthropic');
  assert.equal(result.setup.step, 'error');
  assert.match(result.message, /found.*could not start/);
  assert.match(result.setup.checkCommand, /claude --version/);
});

test('Google missing CLI gives the npm command and explains a missing npm prerequisite', async (t) => {
  const { root } = fixture(t);
  rmSync(join(root, 'bin/gemini'));
  const result = await setupProvider(root, 'google');
  assert.equal(result.setup.step, 'install');
  assert.equal(result.setup.command, 'npm install -g @google/gemini-cli');
  assert.match(result.setup.prerequisite, /Node.js 22.*npm/);
  assert.equal(result.setup.canInstall, false);
});
for (const [id, executable, command] of [
  ['anthropic', 'claude', 'curl -fsSL https://claude.ai/install.sh | bash'],
  ['google', 'gemini', 'npm install -g @google/gemini-cli'],
])
  test(`${id} installation launches only its fixed recipe after explicit Install`, async (t) => {
    const { root } = fixture(t);
    rmSync(join(root, 'bin/' + executable));
    writeFileSync(join(root, 'bin/npm'), '#!/bin/sh\nprintf "10.0.0\\n"\n', { mode: 0o700 });
    const launched = [];
    const result = await installProvider(root, id, { openTerminal: async (value) => launched.push(value) });
    if (process.platform === 'darwin') {
      assert.deepEqual(launched, [command]);
      assert.equal(result.setup.step, 'installing');
      assert.match(result.message, /Installation opened in Terminal/);
    } else assert.deepEqual(launched, []);
    await assert.rejects(installProvider(root, 'untrusted'), /supported provider/);
  });
test('a terminal launch failure retains manual install instructions', async (t) => {
  const { root } = fixture(t);
  rmSync(join(root, 'bin/claude'));
  const result = await installProvider(root, 'anthropic', {
    openTerminal: async () => {
      throw Error('Denied');
    },
  });
  assert.equal(result.setup.step, 'install');
  if (process.platform === 'darwin') assert.match(result.message, /Could not open Terminal/);
  assert.equal(result.setup.command, 'curl -fsSL https://claude.ai/install.sh | bash');
});
test('native installation locations work before Factory is restarted', async (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, '.local/bin'), { recursive: true });
  const source = readFileSync(join(root, 'bin/claude'));
  rmSync(join(root, 'bin/claude'));
  writeFileSync(join(root, '.local/bin/claude'), source, { mode: 0o700 });
  const result = await setupProvider(root, 'anthropic');
  assert.equal(result.ready, true);
});
