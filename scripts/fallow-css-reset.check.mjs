import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assessAudit } from './audit-result.mjs';
import { cleanEnvironment } from './factory-ui/common.mjs';

test('an explicit CSS reset passes unchanged Fallow policy while a new unused selector still blocks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timey-css-reset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'node_modules'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env: cleanEnvironment(), stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'CSS reset check');
  git('config', 'user.email', 'css@example.invalid');
  writeFileSync(
    join(root, '.fallowrc.json'),
    JSON.stringify({ entry: ['app.js', 'index.html'], audit: { gate: 'new-only' } })
  );
  writeFileSync(
    join(root, 'index.html'),
    '<link rel="stylesheet" href="style.css"><main id="root" class="root"></main><script src="app.js"></script>'
  );
  writeFileSync(
    join(root, 'app.js'),
    'document.getElementById("root").innerHTML = `<div class="discuss-message">Message</div><div class="discuss-toolbar">Toolbar</div>`;'
  );
  const css =
    '.root { display: block; }\n.discuss-message {\n  border-bottom: 1px solid;\n  padding: 20px 0;\n}\n.discuss-toolbar { display: flex; }\n';
  writeFileSync(join(root, 'style.css'), css);
  git('add', '.');
  git('commit', '-qm', 'Existing dynamic Discuss consumers');
  const analyze = () => {
    const result = spawnSync(
      resolve('node_modules/.bin/fallow'),
      ['audit', '--base', 'HEAD', '--format', 'json', '--no-cache'],
      { cwd: root, env: cleanEnvironment(), encoding: 'utf8' }
    );
    assert.ok(result.stdout.startsWith('{'), result.stderr);
    return assessAudit(result, ['style.css'], { warningsAsErrors: true });
  };
  const reset = css.replace('border-bottom: 1px solid;', 'border-bottom: none;');
  writeFileSync(join(root, 'style.css'), reset);
  const valid = analyze();
  assert.equal(valid.passed, true, JSON.stringify(valid));
  writeFileSync(join(root, 'style.css'), reset + '.unused-css-reset-canary { display: block; }\n');
  const invalid = analyze();
  assert.equal(invalid.passed, false);
  assert.match(invalid.reasons.join('\n'), /New Fallow findings/);
});
