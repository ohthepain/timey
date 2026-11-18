import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitFixture } from './git-fixture.mjs';
import { StrategyProvider } from './factory-ui/strategy-provider.mjs';
import { infrastructureFailure } from './factory-ui/strategy-repair.mjs';

test('GitHub App 422 retains sanitized validation details and is not a transient retry', async (t) => {
  const { root } = gitFixture(t, 'github-validation-');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const token = 'ghs_fixture_do_not_expose_credential';
  const requests = join(root, 'requests.txt');
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(requests)}, 'request\\n');
process.stdout.write(JSON.stringify({message:'Validation Failed',errors:[{resource:'PullRequest',field:'head',code:'custom',message:'No commits between number_2 and codex/issue-144 '+process.env.GH_TOKEN}],token:process.env.GH_TOKEN}));
process.stderr.write('gh: Validation Failed (HTTP 422)\\nAuthorization: Bearer '+process.env.GH_TOKEN);
process.exitCode=1;
`,
    { mode: 0o755 }
  );
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const provider = new StrategyProvider(root, { repository: 'fixture/timey' });
  provider.credentials = { session: async () => ({ token, slug: 'factory' }) };
  await assert.rejects(provider.gh(['api', 'repos/fixture/timey/pulls']), (error) => {
    assert.equal(error.githubStatus, 422);
    assert.equal(error.githubResponse.message, 'Validation Failed');
    assert.match(error.githubResponse.errors[0].message, /No commits between/);
    assert.match(error.message, /No commits between/);
    assert.equal(infrastructureFailure(error), false);
    assert.equal(JSON.stringify(error).includes(token), false);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.stderr, undefined);
    return true;
  });
  assert.equal(readFileSync(requests, 'utf8'), 'request\n');
});
