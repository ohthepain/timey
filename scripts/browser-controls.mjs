export async function readyControl(scope, { selector, action, view, record }) {
  const control = scope.locator(selector);
  const context = `${action} using ${selector} in ${[view, record].filter(Boolean).join(' / ')}`;
  function requireOne(count) {
    if (!count) throw Error(context + ' failed: control is missing.');
    if (count > 1) throw Error(context + ' failed: ' + count + ' controls matched.');
  }
  requireOne(await control.count());
  if (!(await control.isVisible())) throw Error(context + ' failed: control is hidden.');
  if (!(await control.isEnabled({ timeout: 500 }))) throw Error(context + ' failed: control is disabled.');
  return control;
}

export async function assertControlText(control, expected) {
  const actual = (await control.innerText({ timeout: 500 })).trim();
  if (actual !== expected) {
    throw Error(`Control wording mismatch. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}
