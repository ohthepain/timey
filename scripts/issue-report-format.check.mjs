import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { formatIssueReport, originalRequestSection } from './factory-ui/issue-report-format.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const input = [
  '---',
  'id: 20261117-format',
  'title: "Formatting remains consistent"',
  'state: closed',
  'updated: "2026-11-17T12:00:00.000Z"',
  '---',
  '',
  '# A report',
  '',
  '| one | second |',
  '|-|-|',
  '| x | y |',
  '',
  '```js',
  'const item={first:"a",second:[1,2]};',
  "const deployment = { repository: 'ohthepain/timey', target: 'number_2', sharedIssueQueue: true, runRetro: false };",
  '```',
  '',
].join('\n');
const expected = [
  '---',
  'id: 20261117-format',
  "title: 'Formatting remains consistent'",
  'state: closed',
  "updated: '2026-11-17T12:00:00.000Z'",
  '---',
  '',
  '# A report',
  '',
  '| one | second |',
  '| --- | ------ |',
  '| x   | y      |',
  '',
  '```js',
  "const item = { first: 'a', second: [1, 2] };",
  "const deployment = { repository: 'ohthepain/timey', target: 'number_2', sharedIssueQueue: true, runRetro: false };",
  '```',
  '',
].join('\n');

test('issue formatting retains metadata, Markdown tables and embedded code style', () => {
  assert.equal(formatIssueReport(input), expected);
  assert.equal(formatIssueReport(expected), expected);
});

test('issue formatting preserves original request wording and matches repository formatting', () => {
  const wording = 'Keep   these spaces.\n\n|raw|text|\n|-|-|\n|a|b|';
  const request = originalRequestSection(wording) + '\n';
  assert.equal(formatIssueReport(request), request);
  const normal = execFileSync(join(root, 'node_modules/.bin/vp'), ['fmt', '--stdin-filepath=issue-report.md'], {
    cwd: root,
    input: input + '\n' + request,
    encoding: 'utf8',
  });
  assert.equal(normal, formatIssueReport(input + '\n' + request));
});

test('issue formatting does not evaluate the application Vite configuration', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'issue-format-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, 'scripts/factory-ui'), { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"formatter-fixture","type":"module"}\n');
  copyFileSync(join(root, '.oxfmtrc.json'), join(project, '.oxfmtrc.json'));
  copyFileSync(
    join(root, 'scripts/factory-ui/issue-report-format.mjs'),
    join(project, 'scripts/factory-ui/issue-report-format.mjs')
  );
  symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
  writeFileSync(join(project, 'vite.config.ts'), "throw Error('Formatting must not load application plugins.');\n");
  const module = pathToFileURL(join(project, 'scripts/factory-ui/issue-report-format.mjs')).href;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { formatIssueReport } from ${JSON.stringify(module)}; process.stdout.write(formatIssueReport(${JSON.stringify(input)}));`,
    ],
    {
      cwd: project,
      encoding: 'utf8',
    }
  );
  assert.equal(output, expected);
});
