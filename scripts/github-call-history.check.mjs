import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('GitHub API history counts individual CLI requests and keeps only the latest 30', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'timey-github-calls-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.XDG_STATE_HOME = directory;
  const { finishGitHubCall, readGitHubCalls, resetGitHubCalls, startGitHubCall } =
    await import('./factory-ui/github-call-history.mjs');
  const { runGitHubCli, runGitHubCliSync } = await import('./factory-ui/github-cli.mjs');

  const trace = (path, method, status) => {
    return [
      '* Request at 2026-01-02 12:00:00.123456 +0000 UTC m=+0.001',
      '* Request to https://api.github.com/' + path,
      '> ' + method + ' /ignored HTTP/1.1',
      '> Authorization: fixture-secret',
      '< HTTP/2.0 ' + status,
      '{"token":"fixture-secret"}',
      '* Request took 2.5ms',
    ];
  };
  const output = [
    ...trace('repos/acme/app/pulls?page=1&token=fixture-secret', 'GET', '200 OK'),
    ...trace('repos/acme/app/pulls?page=2', 'GET', '404 Not Found'),
    ...trace('graphql', 'POST', '200 OK'),
  ];
  const cli = join(directory, 'gh');
  writeFileSync(
    cli,
    `#!${process.execPath}
const lines = ${JSON.stringify(output)};
process.stderr.write(lines.splice(0, 3).join('\\n') + '\\n');
setTimeout(() => {
  process.stderr.write(lines.join('\\n') + '\\n');
  process.stdout.write('command result');
}, 250);
`,
    { mode: 0o700 }
  );
  const options = { env: { ...process.env, PATH: directory + ':' + process.env.PATH }, encoding: 'utf8' };
  const command = runGitHubCli(['api', '--paginate', 'repos/acme/app/pulls'], options, 'acme/app');
  let pending;
  for (let attempt = 0; attempt < 100 && !pending; attempt++) {
    await delay(10);
    pending = readGitHubCalls().calls.find((call) => call.result === 'In progress');
  }
  assert.equal(await command, 'command result');
  assert.equal(pending?.operation, 'GET /repos/pulls');
  assert.equal(runGitHubCliSync(['pr', 'view'], options, 'acme/app'), 'command result');
  const initial = readGitHubCalls();
  assert.equal(initial.total, 6);
  assert.equal(initial.failed, 2);
  assert.deepEqual(
    initial.calls.slice(0, 3).map((call) => call.result),
    ['200 OK', '404 Not Found', '200 OK']
  );
  assert.ok(initial.calls.every((call) => call.repository === 'acme/app' && call.durationMs === 2.5));
  assert.equal(JSON.stringify(initial).includes('fixture-secret'), false);

  const old = startGitHubCall({ operation: 'GET /app' });
  for (let index = 0; index < 31; index++) {
    const id = startGitHubCall({ operation: 'GET /app' });
    finishGitHubCall(id, { durationMs: 1, status: 200 });
  }
  finishGitHubCall(old, { durationMs: 50, failure: 'Timed out' });
  const retained = readGitHubCalls();
  assert.equal(retained.calls.length, 30);
  assert.equal(retained.total, 38);
  assert.equal(retained.failed, 3);
  assert.ok(retained.calls.every((call) => call.result === '200 OK'));
  const restarted = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { readGitHubCalls } from './scripts/factory-ui/github-call-history.mjs';
      process.stdout.write(JSON.stringify(readGitHubCalls()));
    `,
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }
  );
  assert.deepEqual(JSON.parse(restarted), JSON.parse(JSON.stringify(retained)));

  const inFlight = startGitHubCall({ operation: 'GET /app' });
  resetGitHubCalls();
  finishGitHubCall(inFlight, { durationMs: 100, status: 403 });
  assert.deepEqual(JSON.parse(JSON.stringify(readGitHubCalls())), { total: 0, failed: 0, calls: [] });
});
