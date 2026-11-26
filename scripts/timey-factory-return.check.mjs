import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { createServer } from 'vite-plus';
import { git } from './factory-ui/common.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve('@playwright/cli/package.json'));
const { chromium } = playwrightRequire('playwright');

function projectFixture(output, name) {
  const project = join(output, name);
  mkdirSync(join(project, '.issues'), { recursive: true });
  git(project, 'init', '-q', '-b', 'dev');
  git(
    project,
    '-c',
    'user.name=Timey browser fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'Fixture'
  );
  return project;
}

function startFactory(project) {
  const child = spawn(process.execPath, [join(root, 'scripts/factory-ui.mjs'), '--project', project, '--port', '0'], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const stopped = new Promise((resolve) => child.once('close', resolve));
  child.on('error', (error) => {
    log += error.message;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (data) => {
      log += data;
    });
  }
  return {
    async origin() {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const address = log.match(/Factory UI: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1];
        if (address) return address;
        if (child.exitCode !== null || child.signalCode !== null) break;
        await delay(100);
      }
      throw Error(`Factory failed to start for ${project}.\n${log}`);
    },
    async close() {
      child.kill();
      return stopped;
    },
  };
}

function discoveryPath(project) {
  return join(project, '.issues/factory-discovery.json');
}

function nextDiscovery(page) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === '/api/factory-status');
}

test('Timey opens the matching local Factory and hides the link when it is unavailable', async () => {
  const evidence = join(root, '.issues/evidence');
  mkdirSync(evidence, { recursive: true });
  const output = mkdtempSync(join(evidence, 'timey-factory-return-'));
  const project = projectFixture(output, 'matching-timey');
  const unrelatedProject = projectFixture(output, 'unrelated-project');
  const previousDirectory = process.cwd();
  process.chdir(project);
  let timey, browser, unrelated;
  const matching = startFactory(project);
  try {
    const matchingOrigin = await matching.origin();
    const discovery = JSON.parse(readFileSync(discoveryPath(project), 'utf8'));
    assert.equal(discovery.port, Number(new URL(matchingOrigin).port));

    Object.assign(process.env, {
      AUTH_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
      BETTER_AUTH_SECRET: 'timey-factory-browser-check-secret-without-accounts',
      BETTER_AUTH_URL: 'http://127.0.0.1',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_FROM: 'fixture@example.test',
      SMTP_SECURE: 'false',
    });
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    timey = await createServer({
      root,
      server: { host: '127.0.0.1', port: 0 },
      css: {
        postcss: { plugins: [tailwindcss({ content: [join(root, 'src/**/*.{js,jsx,ts,tsx}')] }), autoprefixer()] },
      },
    });
    await timey.listen();
    const timeyOrigin = new URL(timey.resolvedUrls.local[0]).origin;
    browser = await chromium.launch({ channel: 'chrome' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['midi-sysex'] });
    const page = await context.newPage();
    const observer = await context.newPage();
    const factory = page.getByRole('link', { name: 'Factory', exact: true });
    const observedFactory = observer.getByRole('link', { name: 'Factory', exact: true });
    await page.goto(timeyOrigin);
    await observer.goto(timeyOrigin);
    await factory.waitFor();
    await observedFactory.waitFor();
    const href = await factory.getAttribute('href');
    assert.equal(new URL(href).origin, matchingOrigin);
    await page.screenshot({ path: join(output, 'timey-factory-link.png') });

    await Promise.all([page.waitForURL(new URL('/', matchingOrigin).href), factory.click()]);
    await page.getByRole('heading', { name: basename(project), exact: true }).waitFor();
    const workspace = await page.request.get(matchingOrigin + '/api/runtime');
    assert.equal(workspace.status(), 200);
    assert.equal((await workspace.json()).project, project);
    const openedWorkspace = page.url();
    await page.screenshot({ path: join(output, 'matching-factory-workspace.png') });

    assert.equal(await matching.close(), 0, 'Matching Factory stopped cleanly');
    await observedFactory.waitFor({ state: 'detached' });
    const stoppedFactoryLinkCount = await observedFactory.count();
    assert.equal(stoppedFactoryLinkCount, 0);
    await observer.screenshot({ path: join(output, 'timey-matching-factory-stopped.png') });

    unrelated = startFactory(unrelatedProject);
    const unrelatedOrigin = await unrelated.origin();
    writeFileSync(
      discoveryPath(project),
      JSON.stringify({ ...discovery, port: Number(new URL(unrelatedOrigin).port) })
    );
    const [status] = await Promise.all([nextDiscovery(observer), observer.reload()]);
    assert.equal(status.status(), 200);
    assert.deepEqual(await status.json(), { url: null });
    await nextDiscovery(observer);
    const unrelatedFactoryLinkCount = await observedFactory.count();
    assert.equal(unrelatedFactoryLinkCount, 0);
    await observer.screenshot({ path: join(output, 'timey-only-unrelated-factory.png') });

    const proof = join(output, 'timey-factory-return.json');
    writeFileSync(
      proof,
      JSON.stringify(
        {
          revision: git(root, 'rev-parse', 'HEAD'),
          browser: browser.version(),
          timeyOrigin,
          matchingFactory: { launchedWithPort: 0, project, href, openedWorkspace, stoppedFactoryLinkCount },
          unrelatedFactory: {
            launchedWithPort: 0,
            project: unrelatedProject,
            origin: unrelatedOrigin,
            unrelatedFactoryLinkCount,
          },
        },
        null,
        2
      ) + '\n'
    );
    console.log(`Timey Factory return browser evidence: ${proof}`);
  } finally {
    await Promise.all([browser?.close(), timey?.close(), matching.close(), unrelated?.close()]);
    process.chdir(previousDirectory);
  }
});
