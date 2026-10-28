import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitFixture } from './git-fixture.mjs';
import { factory } from './factory-ledger.mjs';
import { FactoryUI } from './factory-ui/service.mjs';

export const captureStages = [
  ['ready-for-grilling', 'backlog'],
  ['ready-for-repro', 'to-do'],
  ['ready-to-prototype', 'prototype'],
  ['ready-to-fix', 'implement'],
  ['ready-to-verify', 'verify'],
  ['ready-for-commit', 'commit'],
  ['ready-to-close', 'final'],
  ['closed', 'closed'],
];
export function proposal(description, role = 'ready-to-fix') {
  const index = captureStages.findIndex(([r]) => r === role);
  return {
    title: 'Capture ' + description.slice(0, 80),
    category: role === 'ready-for-repro' ? 'bug' : 'enhancement',
    excerpt: description,
    initialRole: role,
    reproduction: role === 'ready-for-repro' ? 'required' : 'inapplicable',
    reason: 'The supplied request defines the intended outcome.',
    verification: 'Check the requested behavior in the rendered browser.',
    skips: captureStages.slice(0, index).map(([r]) => ({
      role: r,
      reason:
        r === 'ready-for-repro'
          ? 'A requested enhancement has no existing failure to reproduce.'
          : 'The original request settles this stage; no design experiment or clarification is needed.',
    })),
  };
}
export function captureFixture(t, options = {}) {
  const { root, git } = gitFixture(t, 'factory-capture-');
  writeFileSync(join(root, '.gitignore'), '.issues/\nnode_modules/\n');
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  const helper = join(root, '.agents/skills/issues/scripts');
  mkdirSync(helper, { recursive: true });
  for (const name of ['human-input.mjs', 'human-input-version.json'])
    cpSync(resolve('.agents/skills/issues/scripts', name), join(helper, name));
  git('add', '.');
  git('commit', '-qm', 'capture fixture');
  mkdirSync(join(root, '.issues'));
  writeFileSync(
    join(root, '.issues/triage-labels.md'),
    '| Role | State | Next | Exit |\n| --- | --- | --- | --- |\n' +
      captureStages
        .map(([role, state], i) => `| ${role} | ${state} | ${captureStages[i + 1]?.[1] || '—'} | Required evidence |`)
        .join('\n')
  );
  writeFileSync(join(root, '.issues/preferences.json'), '{"commit":true}\n');
  writeFileSync(
    join(root, '.issues/20261025-existing.md'),
    '---\nid: 20261025-existing\ntitle: Existing issue\nstate: backlog\ngrill_later: false\nautonomy: ask\n---\nPreserve original bytes.\n'
  );
  factory(root).init();
  const service = new FactoryUI(root, {
    capture: { assess: async (description) => ({ issues: [proposal(description)] }), ...options },
  });
  t.after(() => service.close());
  return { root, git, service };
}
