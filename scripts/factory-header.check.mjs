import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { cleanEnvironment, git } from './factory-ui/common.mjs';

const require = createRequire(import.meta.url);
const { chromium } = createRequire(require.resolve('@playwright/cli/package.json'))('playwright');

async function startFactory(source, project) {
  const child = spawn(process.execPath, ['scripts/factory-ui.mjs', '--preview', '--project', project], {
    cwd: source,
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => (output += chunk));
  const exited = once(child, 'exit');
  const url = await new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      const address = /Factory UI: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout)?.[1];
      if (address) resolve(address);
    });
    exited.then(([code]) => reject(Error(`Factory exited (${code}): ${output}`)), reject);
  });
  return {
    url,
    async stop() {
      child.kill('SIGTERM');
      await exited;
    },
  };
}

async function readHeader(page, url, revision) {
  await page.goto(url);
  const header = page.getByRole('banner', { name: 'Factory' });
  const button = header.getByRole('button', { name: `Copy Factory revision ${revision}` });
  const bounds = await button.boundingBox();
  assert.ok(bounds);
  const headerBounds = await header.boundingBox();
  assert.ok(headerBounds.x + headerBounds.width - bounds.x - bounds.width <= 16, 'Revision is at the far right');
  assert.equal(await header.getByText(/^flow$/i).count(), 0);
  assert.equal(await page.locator('#issue-flow-menu').count(), 1);
  const displayed = await button.innerText();
  assert.equal(displayed, revision.slice(0, 7));
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await button.click();
  await page.getByText('Factory revision copied.', { exact: true }).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, revision);
  return { displayed, copied, flowBadge: 'absent' };
}

test(
  'Factory header removes the Flow badge and copies the startup revision until restart',
  { timeout: 45000 },
  async (t) => {
    const output = resolve('.issues/evidence');
    mkdirSync(output, { recursive: true });
    const source = mkdtempSync(join(output, 'factory-header-source-'));
    const project = mkdtempSync(join(output, 'factory-header-project-'));
    let server, browser;
    try {
      git(project, 'init', '-q');
      git(source, 'init', '-q');
      git(source, 'config', 'user.name', 'Factory header fixture');
      git(source, 'config', 'user.email', 'factory-header@example.invalid');
      git(source, 'config', 'core.hooksPath', '/dev/null');
      cpSync('scripts', join(source, 'scripts'), { recursive: true });
      cpSync('factory', join(source, 'factory'), { recursive: true });
      cpSync('.github/pr-repair-tests', join(source, '.github/pr-repair-tests'), { recursive: true });
      writeFileSync(join(source, 'package.json'), '{"type":"module"}\n');
      writeFileSync(join(source, '.gitignore'), '/node_modules\n');
      symlinkSync(resolve('node_modules'), join(source, 'node_modules'), 'dir');
      git(source, 'add', '.');
      git(source, 'commit', '-qm', 'Factory source');
      const initial = git(source, 'rev-parse', 'HEAD');
      server = await startFactory(source, project);
      browser = await chromium.launch({ headless: true, channel: 'chrome' });
      const page = await browser.newPage({
        permissions: ['clipboard-read', 'clipboard-write'],
        viewport: { width: 1440, height: 900 },
      });
      const before = await readHeader(page, server.url, initial);

      git(source, 'commit', '--allow-empty', '-qm', 'Advance Factory HEAD');
      const advanced = git(source, 'rev-parse', 'HEAD');
      assert.notEqual(advanced, initial);
      const whileRunning = await readHeader(page, server.url, initial);

      await server.stop();
      server = await startFactory(source, project);
      const afterRestart = await readHeader(page, server.url, advanced);
      await page.setViewportSize({ width: 390, height: 844 });
      const afterRestartMobile = await readHeader(page, server.url, advanced);
      t.diagnostic(JSON.stringify({ initial, advanced, before, whileRunning, afterRestart, afterRestartMobile }));
    } finally {
      await browser?.close();
      await server?.stop();
      rmSync(source, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }
);
