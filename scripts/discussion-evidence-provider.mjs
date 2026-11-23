import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDiscussionRuntime } from './factory-ui/discussion-codex.mjs';

const root = mkdtempSync(join(tmpdir(), 'timey-discussion-evidence-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.name', 'Fixture');
git('config', 'user.email', 'fixture@example.invalid');
git('config', 'core.hooksPath', '/dev/null');
writeFileSync(join(root, 'recent.txt'), 'recent-work-proof-7842');
git('add', 'recent.txt');
git('commit', '-qm', 'Recent work fixture');
const revision = git('rev-parse', 'HEAD');
const commands = [];
const runtime = createDiscussionRuntime(undefined, {
  root,
  onEvent: ({ method, params }) => {
    if (method === 'item/completed' && params.item?.type === 'commandExecution') commands.push(params.item);
  },
});
const timer = setTimeout(() => runtime.close(), 90_000);
try {
  await runtime.begin(
    { purpose: 'Read-only evidence verification in a disposable fixture.' },
    'Read recent.txt, the latest Git revision and the linked input. Find its middle marker using a bounded search, printing only matching markers rather than filler. Return fileText, revision and middleMarker. No writes or test commands.'
  );
  const result = JSON.parse(
    await runtime.ask(
      'Evidence begins\n' + 'x'.repeat(550_000) + '\nMIDDLE-MARKER-9627\n' + 'x'.repeat(550_000) + '\nEvidence ends',
      [],
      {
        type: 'object',
        properties: { fileText: { type: 'string' }, revision: { type: 'string' }, middleMarker: { type: 'string' } },
        required: ['fileText', 'revision', 'middleMarker'],
        additionalProperties: false,
      }
    )
  );
  assert.equal(result.fileText.trim(), 'recent-work-proof-7842');
  assert.equal(result.revision, revision);
  assert.equal(result.middleMarker, 'MIDDLE-MARKER-9627');
  assert.ok(commands.length > 0, 'The live provider used native inspection tools');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  writeFileSync(join(root, 'proof.json'), JSON.stringify({ result, commands }, null, 2));
  console.log('PASS live evidence reads: ' + join(root, 'proof.json'));
} finally {
  clearTimeout(timer);
  runtime.close();
}
