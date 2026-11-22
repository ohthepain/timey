import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { createDiscussionRuntime } from './factory-ui/discussion-codex.mjs';
import { digest } from './factory-ui/common.mjs';

function provider(t) {
  const { root, git } = gitFixture(t, 'discussion-evidence-');
  const home = join(root, 'provider');
  const bin = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(home, 'config.toml'), 'model = "fixture"\n');
  writeFileSync(join(home, 'auth.json'), '{}');
  const log = join(root, 'protocol.jsonl');
  writeFileSync(
    join(bin, 'codex'),
    `#!/usr/bin/env node
const {createInterface} = require('node:readline');
const {appendFileSync, readFileSync} = require('node:fs');
const log = ${JSON.stringify(log)};
appendFileSync(log, JSON.stringify({config: readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8')}) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(log, JSON.stringify(request) + '\\n');
  if (request.id === undefined) return;
  if (request.method === 'thread/start') return send({id: request.id, result: {thread: {id: 'fixture', ephemeral: true, path: null}}});
  if (request.method === 'turn/start') {
    send({id: request.id, result: {turn: {id: 'turn'}}});
    send({method: 'item/completed', params: {threadId: 'fixture', item: {id: 'answer', type: 'agentMessage', text: 'Reviewed.'}}});
    return send({method: 'turn/completed', params: {threadId: 'fixture', turn: {id: 'turn', status: 'completed'}}});
  }
  send({id: request.id, result: {}});
});
`,
    { mode: 0o700 }
  );
  const previousPath = process.env.PATH;
  const previousHome = process.env.CODEX_HOME;
  process.env.PATH = bin + ':' + previousPath;
  process.env.CODEX_HOME = home;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  });
  return { root, git, records: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

function reference(text) {
  const start = text.indexOf('{"path":');
  assert.ok(start >= 0, 'Provider receives an evidence reference');
  return JSON.parse(text.slice(start, text.indexOf('}', start) + 1));
}

test('temporary discussions link complete large inputs and context while permitting read-only project inspection', async (t) => {
  const f = provider(t);
  writeFileSync(join(f.root, 'recent.txt'), 'recent project work');
  f.git('add', 'recent.txt');
  f.git('commit', '-qm', 'Recent project change');
  const runtime = createDiscussionRuntime(undefined, { root: f.root });
  t.after(() => runtime.close());
  const context = { issue: 'full context ' + 'a'.repeat(1_100_000) };
  const text = 'first ' + 'b'.repeat(600_000) + 'middle evidence' + 'b'.repeat(600_000) + ' last';
  const instructions = 'Consider relevant recent work.\n' + 'z'.repeat(1_100_000);
  await runtime.begin(context, instructions);
  assert.equal(await runtime.ask(text), 'Reviewed.');
  assert.equal(await runtime.ask('Follow-up question'), 'Reviewed.');
  const records = f.records();
  const start = records.find(({ method }) => method === 'thread/start').params;
  assert.equal(start.cwd, realpathSync(f.root));
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.ok(start.developerInstructions.length < 16000);
  const contextFile = reference(start.developerInstructions);
  assert.deepEqual(JSON.parse(readFileSync(contextFile.path, 'utf8')), context);
  const instructionsFile = reference(
    start.developerInstructions.slice(start.developerInstructions.indexOf('Full instructions'))
  );
  assert.equal(readFileSync(instructionsFile.path, 'utf8'), instructions);
  assert.match(records[0].config, /shell_tool = true/);
  const turns = records.filter(({ method }) => method === 'turn/start');
  const prompt = turns[0].params.input[0].text;
  assert.ok(prompt.length < 16000);
  const inputFile = reference(prompt);
  assert.equal(readFileSync(inputFile.path, 'utf8'), text);
  assert.equal(inputFile.sha256, digest(text));
  assert.equal(turns[1].params.input[0].text, 'Follow-up question');
  runtime.close();
  // Child shutdown removes only its ephemeral evidence directory, never the project.
  const deadline = Date.now() + 5000;
  while (existsSync(dirname(contextFile.path)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(dirname(contextFile.path)), false);
  assert.equal(readFileSync(join(f.root, 'recent.txt'), 'utf8'), 'recent project work');
});
