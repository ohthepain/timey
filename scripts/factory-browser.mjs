import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { git, digest } from './factory-ui/common.mjs';
import sortingBrowserChecks from './browser-scenarios/queue-sorting.mjs';
import { browserFixture } from './browser-fixture.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const checkoutFlag = process.argv.indexOf('--checkout');
const root = checkoutFlag < 0 ? process.cwd() : resolve(process.argv[checkoutFlag + 1]);
const output = resolve(process.env.TIMEY_BROWSER_OUTPUT || join(root, '.issues/evidence/browser-' + randomUUID()));
mkdirSync(output, { recursive: true });
const session = 'verify-' + randomUUID();
const cli = join(source, '../node_modules/.bin/playwright-cli');
const server = browserFixture(root);
const config = join(output, 'browser-config.json');
writeFileSync(
  config,
  JSON.stringify({ browser: { browserName: 'chromium', isolated: true, launchOptions: { headless: true } } })
);
const browserSourcePaths = ['scripts/factory-ui', 'scripts/browser-fixture.mjs'];
function browserSourceDiff() {
  return git(root, 'diff', '--binary', '--', ...browserSourcePaths);
}
const candidate = {
  revision: git(root, 'rev-parse', 'HEAD'),
  source: digest(browserSourceDiff()),
};
const results = [];
let passed = false;
async function run(label, args) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(cli, ['--session', session, ...args], { cwd: output, env: process.env });
    let text = '';
    child.stdout.on('data', (data) => {
      text += data;
    });
    child.stderr.on('data', (data) => {
      text += data;
    });
    child.once('error', reject);
    child.once('close', (code) => resolveResult({ code, text }));
  });
  writeFileSync(join(output, label.replaceAll('/', '-') + '.log'), result.text);
  if (result.code !== 0 || result.text.includes('### Error')) throw Error(label + ': ' + result.text);
  return result.text;
}
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const scenarios = readdirSync(source)
    .filter((name) => /^factory-browser-.+\.mjs$/.test(name))
    .sort();
  // Legacy pilot: the tracked sorting test registers its browser replay, even if its UI controls regress.
  if (existsSync(join(root, 'scripts/factory-queue.check.mjs'))) scenarios.push('browser-scenarios/queue-sorting.mjs');
  if (!scenarios.length) throw Error('No browser scenarios are registered.');
  await run('open', ['open', url, '--config', config, '--idle-timeout', '60000']);
  for (const name of scenarios) {
    await run('reload-' + name, ['goto', url]);
    const check =
      name === 'browser-scenarios/queue-sorting.mjs'
        ? sortingBrowserChecks
        : (await import(pathToFileURL(join(source, name)))).default;
    const path = join(output, name.replaceAll('/', '-'));
    writeFileSync(path, '(' + check.toString() + ')');
    const raw = await run(name, ['run-code', '--filename', path]);
    if (!/"passed":\s*true/.test(raw)) throw Error('Browser scenario returned no passing assertions: ' + name);
    results.push({ name, passed: true, log: join(output, name.replaceAll('/', '-') + '.log') });
    console.log('PASS browser scenario: ' + name);
  }
  const after = digest(browserSourceDiff());
  if (after !== candidate.source) {
    const stat = git(root, 'diff', '--stat', '--', ...browserSourcePaths);
    throw Error(
      'Served factory UI changed during browser verification.' +
        (stat ? '\n' + stat : '\n(no diff stat; compare scripts/factory-ui manually)')
    );
  }
  passed = true;
} finally {
  try {
    await run('close', ['close']);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    writeFileSync(join(output, 'results.json'), JSON.stringify({ candidate, results, passed }, null, 2));
  }
}
