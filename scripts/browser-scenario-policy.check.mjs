import test from 'node:test';
import assert from 'node:assert/strict';
import { browserScenarioSelected } from './browser-scenario-policy.mjs';

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
