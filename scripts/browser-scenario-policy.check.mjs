import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenarioSelected } from './browser-scenario-policy.mjs';
import { normalizeFocusedTests } from './verify-merge-checks.mjs';

void test('a named Factory capture scenario runs without other browser cases', () => {
  const name = 'factory-browser-capture-start.mjs';
  const args = ['--scenario=' + name];
  assert.deepEqual(
    [name, ...ordinaryScenarios, ...dragScenarios].filter((scenario) => browserScenarioSelected(scenario, args)),
    [name]
  );
  assert.equal(browserScenarioSelected(name, [args[0], args[0]]), false);
});

void test('repair-first accepts one named Factory case while rejecting its aggregate and unsafe selections', () => {
  const command = ['node', 'scripts/factory-browser.mjs', '--scenario=factory-browser-capture-start.mjs'];
  assert.deepEqual(normalizeFocusedTests([command]), [command]);
  for (const args of [[], ['--scenario=../outside.mjs'], ['--scenario='], [command[2], command[2]]])
    assert.throws(() => normalizeFocusedTests([command.slice(0, 2).concat(args)]), /Record focused test commands/);
});

const dragScenarios = [
  'factory-browser-issue-folders.mjs',
  'factory-browser-queue-drag.mjs',
  'Issue folders retain every issue and accept drags between folders',
];
const ordinaryScenarios = [
  'factory-browser-queue.mjs',
  'Project Discuss retains independent conversations, settings and explicit controls',
];

test('routine and full regression exclude drag-and-drop browser scenarios', () => {
  for (const args of [[], ['--full-regression']]) {
    assert.deepEqual(
      [...ordinaryScenarios, ...dragScenarios].filter((name) => browserScenarioSelected(name, args)),
      ordinaryScenarios
    );
  }
});

test('the explicit drag-and-drop command selects only drag scenarios', () => {
  assert.deepEqual(
    [...ordinaryScenarios, ...dragScenarios].filter((name) => browserScenarioSelected(name, ['--drag-and-drop'])),
    dragScenarios
  );
});
