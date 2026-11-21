import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockCatalog, blockExtensions } from './factory-ui/block-catalog.mjs';
import { executionBlockSkill } from './factory-ui/issue-execution-settings.mjs';
import { readClarificationSkills } from './factory-ui/project-discuss.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timey-block-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const personal = join(root, 'personal');
  mkdirSync(personal);
  const directory = join(root, blockExtensions);
  mkdirSync(directory, { recursive: true });
  return { root, personal, directory };
}
test('Markdown extensions add personal and project skill names and sources to the bundled list', (t) => {
  const { root, personal, directory } = fixture(t);
  writeFileSync(join(personal, 'work.md'), '# Skill list\n\n- my-work\n');
  writeFileSync(
    join(directory, 'work.md'),
    '# Skill list\n\n- [team-work](https://example.com/team/SKILL.md)\n\n# System prompt\n\nFollow team conventions.\n'
  );
  const catalog = new BlockCatalog(root, { userSkillsDirectory: personal });
  const result = catalog.read();
  assert.deepEqual(result.errors, []);
  const work = result.entries.find((entry) => entry.id === 'work');
  assert.deepEqual(work.skills, ['poteto-mode', 'arena', 'swarm', 'my-work', 'team-work']);
  assert.equal(work.skillSources['team-work'], 'https://example.com/team/SKILL.md');
  assert.equal(work.defaultSkill, 'poteto-mode');
  assert.equal(
    executionBlockSkill({ kind: 'work', skill: null, skillExplicit: false }, work, { values: { skill: 'none' } }),
    'poteto-mode'
  );
  assert.equal(executionBlockSkill({ kind: 'work', skill: null, skillExplicit: true }, work), null);
});

test('duplicate skill entries are rejected and opening an empty extension changes no definition', (t) => {
  const { root, personal } = fixture(t);
  const catalog = new BlockCatalog(root, { userSkillsDirectory: personal });
  const before = catalog.read().entries.find((entry) => entry.id === 'work');
  const path = catalog.openExtension('work');
  assert.equal(catalog.read().entries.find((entry) => entry.id === 'work').checksum, before.checksum);
  writeFileSync(path, '# Skill list\n\n- repeated\n- repeated\n');
  assert.ok(catalog.read().errors.some((error) => error.includes('unique skill name')));
});

test('chat grilling uses an additive Markdown extension and keeps No Grilling last', (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'user/chat'), { recursive: true });
  writeFileSync(join(root, 'user/chat/grilling.md'), '# Skill list\n\n- [team-grilling](../skills/team/SKILL.md)\n');
  const entries = readClarificationSkills(root);
  assert.ok(entries.some((entry) => entry.name === 'grill-me'));
  assert.equal(entries.find((entry) => entry.name === 'team-grilling').source, join(root, 'user/skills/team/SKILL.md'));
  assert.equal(entries.at(-1).name, 'none');
});
