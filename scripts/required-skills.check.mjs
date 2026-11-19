import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readRequiredSkillSets, skillSetup } from './factory-ui/required-skills.mjs';

const requiredSkillSets = readRequiredSkillSets(process.cwd());

test('setup identifies incomplete collections and requests installation from their sources', () => {
  const result = skillSetup([{ name: 'poteto-mode' }]);
  assert.equal(result.needed, true);
  assert.deepEqual(
    result.sets[0].missing,
    requiredSkillSets[0].skills.filter((name) => name !== 'poteto-mode')
  );
  for (const set of requiredSkillSets) assert.ok(result.prompt.includes(set.source));
  assert.match(result.prompt, /Preserve existing custom skills/);
});

test('setup disappears once all required core skills are discoverable', () => {
  const result = skillSetup(requiredSkillSets.flatMap((set) => set.skills.map((name) => ({ name }))));
  assert.equal(result.needed, false);
  assert.equal(result.prompt, '');
  assert.ok(result.sets.every((set) => !set.missing.length));
});

test('a control checks only and all of its skill options', () => {
  const required = ['grilling', 'grill-me', 'grill-with-docs'];
  const available = required.map((name) => ({ name }));
  assert.equal(skillSetup(available, required).needed, false);
  for (const missing of required) {
    const result = skillSetup(
      available.filter((skill) => skill.name !== missing),
      required
    );
    assert.equal(result.needed, true);
    assert.deepEqual(
      result.sets.flatMap((set) => set.missing),
      [missing]
    );
  }
});

test('projects define independent required sets and installation URLs, including local skills', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timey-skill-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readRequiredSkillSets(root), []);
  mkdirSync(join(root, 'user/skills'), { recursive: true });
  const sets = [
    { name: 'Custom collection', source: 'https://example.com/team/skills', skills: ['custom'] },
    { name: 'Local', skills: ['local-skill'] },
  ];
  writeFileSync(join(root, 'user/skills/requirements.json'), JSON.stringify(sets));
  assert.deepEqual(readRequiredSkillSets(root), sets);
  const setup = skillSetup([{ name: 'local-skill' }], undefined, root);
  assert.match(setup.prompt, /https:\/\/example.com\/team\/skills/);
  assert.doesNotMatch(setup.prompt, /mattpocock|cursor/);
  assert.equal(skillSetup([{ name: 'local-skill' }, { name: 'custom' }], undefined, root).needed, false);
});
