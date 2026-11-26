import test from 'node:test';
import assert from 'node:assert/strict';
import { flowBrowserScenarioSelected } from './browser-scenario-policy.mjs';
import { normalizeFocusedTests } from './verify-merge-checks.mjs';

void test('Flow focused commands keep selections and modifiers on the intended scenarios', () => {
  const command = ['node', 'scripts/flow-browser.mjs'];
  const noChanges = 'Publication with no changes offers Cannot Reproduce closure';
  const folderSettings = 'Folder settings inherit, repair, search and act on selected open or closed issues';
  const masterIssues = 'Master issue hierarchy and badges across the workspace';
  const proposals = 'Pending proposals can be approved or deleted after confirmation without starting work';
  const cases = [
    [
      ['--no-changes', '--folder-settings', '--reverse-fixture-scenarios'],
      [noChanges, folderSettings],
    ],
    [['--proposals'], [proposals]],
    [['--delayed-delete'], [proposals]],
    [['--master-issues'], [masterIssues]],
  ];
  for (const [args, expected] of cases) {
    const argv = command.concat(args);
    assert.deepEqual(normalizeFocusedTests([argv]), [argv]);
    assert.deepEqual(
      [noChanges, folderSettings, proposals, masterIssues].filter((scenario) =>
        flowBrowserScenarioSelected(scenario, args)
      ),
      expected
    );
  }
});

const dragScenarios = ['Issue folders retain every issue and accept drags between folders'];
const ordinaryScenarios = ['Project Discuss retains independent conversations, settings and explicit controls'];

test('routine and full regression exclude drag-and-drop browser scenarios', () => {
  for (const args of [[], ['--full-regression']]) {
    assert.deepEqual(
      [...ordinaryScenarios, ...dragScenarios].filter((name) => flowBrowserScenarioSelected(name, args)),
      ordinaryScenarios
    );
  }
});

test('the explicit drag-and-drop command selects only drag scenarios', () => {
  assert.deepEqual(
    [...ordinaryScenarios, ...dragScenarios].filter((name) => flowBrowserScenarioSelected(name, ['--drag-and-drop'])),
    dragScenarios
  );
});
