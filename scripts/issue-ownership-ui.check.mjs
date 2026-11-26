import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

void test('ownership recovery cannot accept input before the selected claim is ready', async () => {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { hidden: false, value: '', checked: false, addEventListener() {} });
      return elements.get(id);
    },
  };
  const window = {};
  const script = fileURLToPath(new URL('./factory-ui/issue-ownership-ui.js', import.meta.url));
  vm.runInNewContext(readFileSync(script, 'utf8'), { window, document }, { filename: script });
  const pending = Promise.withResolvers();
  const ui = window.createIssueOwnershipUI({ request: () => pending.promise });
  const rendering = ui.render({ id: 'selected', ownership: { token: 'claim' } }, false);
  const controls = document.getElementById('issue-ownership-controls');
  const release = document.getElementById('release-issue-claim');
  assert.equal(controls.hidden, true, 'Loading must not expose a form whose inputs will be cleared.');
  assert.equal(release.hidden, true);
  pending.resolve({ issueId: 'selected', ownership: { token: 'claim' }, canRecover: true });
  await rendering;
  assert.equal(controls.hidden, false);
  assert.equal(release.hidden, false);
  const reason = document.getElementById('issue-ownership-reason');
  reason.value = 'The runner has stopped.';
  await ui.render({ id: 'selected', ownership: { token: 'claim' } }, false);
  assert.equal(reason.value, 'The runner has stopped.', 'An unchanged claim preserves the recovery draft.');
  await ui.render({ id: 'selected' }, false);
  assert.equal(release.hidden, true);
});
