import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simplifyAIText } from './factory-ui/ai-text-bro.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-text-bro-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'user/skills/bro');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'SKILL.md');
  writeFileSync(
    path,
    '---\nname: bro\ndescription: Plain speech\ndisable-model-invocation: true\n---\nRestate the previous message in plain language.\n'
  );
  const calls = [];
  const connection = {
    async ready() {},
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'skills/list') return { data: [] };
      return { thread: { id: 'rewrite' } };
    },
    async turn(...args) {
      calls.push({ method: 'turn', args });
      return 'Plain words.';
    },
    close() {
      calls.push({ method: 'close' });
    },
  };
  const options = { createConnection: () => connection, modelSettings: () => ({ model: 'fixture', effort: 'low' }) };
  return { root, calls, connection, options };
}

test('bro loads the selected skill and rewrites in a separate read-only conversation', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await simplifyAIText({ root: f.root }, { text: 'Complex words.' }, f.options), {
    text: 'Plain words.',
  });
  const start = f.calls.find(({ method }) => method === 'thread/start').params;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.ephemeral, true);
  assert.equal(start.config['features.shell_tool'], false);
  const turn = f.calls.find(({ method }) => method === 'turn').args;
  assert.deepEqual(JSON.parse(turn[2]), { text: 'Complex words.' });
  assert.match(turn[4][0].text, /Selected project skill: bro/);
  assert.match(turn[4][0].text, /Restate the previous message in plain language/);
  assert.equal(f.calls.at(-1).method, 'close');
});

test('bro rejects missing, oversized, and failed rewrites without replacing the source', async (t) => {
  const f = fixture(t);
  await assert.rejects(simplifyAIText({ root: f.root }, { text: '' }, f.options), /Choose text/);
  await assert.rejects(simplifyAIText({ root: f.root }, { text: 'x'.repeat(48001) }, f.options), /48 KB/);
  assert.equal(f.calls.length, 0);
  f.connection.turn = async () => {
    throw Error('Provider unavailable');
  };
  await assert.rejects(simplifyAIText({ root: f.root }, { text: 'Original' }, f.options), /Provider unavailable/);
  assert.equal(f.calls.at(-1).method, 'close');
  rmSync(join(f.root, 'user'), { recursive: true });
  await assert.rejects(simplifyAIText({ root: f.root }, { text: 'Original' }, f.options), /bro skill is unavailable/);
  assert.equal(f.calls.at(-1).method, 'close');
});
