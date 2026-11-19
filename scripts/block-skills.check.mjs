import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockCatalog } from './factory-ui/block-catalog.mjs';
import { executionBlockSkill } from './factory-ui/issue-execution-settings.mjs';

test('block skill lists extend installed defaults with personal and project choices', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timey-block-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const personal = join(root, 'personal.json');
  writeFileSync(personal, JSON.stringify({ work: { skills: ['my-work'], defaultSkill: 'my-work' } }));
  mkdirSync(join(root, 'user/flow'), { recursive: true });
  writeFileSync(
    join(root, 'user/flow/block-skills.json'),
    JSON.stringify({ work: { skills: ['team-work'], defaultSkill: 'team-work' } })
  );
  const catalog = new BlockCatalog(root, { userSkillsPath: personal });
  const result = catalog.read();
  assert.deepEqual(result.errors, []);
  const work = result.entries.find((entry) => entry.id === 'work');
  assert.deepEqual(work.skills, ['poteto-mode', 'arena', 'swarm', 'my-work', 'team-work']);
  assert.equal(work.defaultSkill, 'team-work');
  assert.equal(
    executionBlockSkill({ kind: 'work', skill: null, skillExplicit: false }, work, { values: { skill: 'none' } }),
    'team-work'
  );
  assert.equal(executionBlockSkill({ kind: 'work', skill: null, skillExplicit: true }, work), null);
  const checksum = work.checksum;
  writeFileSync(
    join(root, 'user/flow/block-skills.json'),
    JSON.stringify({ work: { skills: ['team-work'], defaultSkill: null } })
  );
  const changed = catalog.read().entries.find((entry) => entry.id === 'work');
  assert.equal(changed.defaultSkill, null);
  assert.notEqual(changed.checksum, checksum);
});

test('Work ships with poteto-mode while other block defaults retain their settings', () => {
  const work = new BlockCatalog(undefined, { userSkillsPath: '/nonexistent/timey-config' })
    .read()
    .entries.find((entry) => entry.id === 'work');
  assert.equal(work.defaultSkill, 'poteto-mode');
});

test('an invalid configured default blocks execution rather than silently selecting another skill', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timey-invalid-block-skill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'user/flow'), { recursive: true });
  writeFileSync(join(root, 'user/flow/block-skills.json'), JSON.stringify({ work: { defaultSkill: 'unlisted' } }));
  const result = new BlockCatalog(root, { userSkillsPath: '/nonexistent/timey-config' }).read();
  assert.ok(result.errors.some((error) => error.includes('must be listed')));
  assert.equal(result.entries.find((entry) => entry.id === 'work').usable, false);
});
