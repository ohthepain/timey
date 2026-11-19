import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredSkillSets, skillSetup } from './factory-ui/required-skills.mjs';

test('setup identifies incomplete collections and requests installation from their sources', () => {
  const result = skillSetup([{ name: 'poteto-mode' }]);
  assert.equal(result.needed, true);
  assert.deepEqual(result.sets[0].missing, ['setup-pstack', 'grilling']);
  for (const set of requiredSkillSets) assert.ok(result.prompt.includes(set.source));
  assert.match(result.prompt, /Preserve existing custom skills/);
});

test('setup disappears once all required core skills are discoverable', () => {
  const result = skillSetup(requiredSkillSets.flatMap((set) => set.skills.map((name) => ({ name }))));
  assert.equal(result.needed, false);
  assert.equal(result.prompt, '');
  assert.ok(result.sets.every((set) => !set.missing.length));
});
