import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = createRequire(require.resolve('@playwright/cli/package.json'))('playwright');
const output = resolve('.issues/evidence/capture-grilling-' + randomUUID());
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<button id="create-issue">Create issue</button>' })
  );
  await page.goto('https://capture.invalid');
  await page.addStyleTag({
    content: [...readFileSync('scripts/factory-ui/index.html', 'utf8').matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((match) => match[1])
      .join('\n'),
  });
  await page.evaluate(() => {
    const fixtures = {
      '/api/capture-grilling-skills': [
        { label: 'Grilling', skill: 'grilling' },
        { label: 'Grill Me', skill: 'grill-me' },
      ],
      '/api/issue-folder-default': { folder: 'Inbox' },
      '/api/issue-stores': { selected: 'files', profiles: [{ id: 'files', label: 'Local files' }] },
    };
    window.fetch = async (url) => ({
      ok: true,
      json: async () => fixtures[new URL(url, location.href).pathname] ?? ['Inbox'],
    });
    window.submissions = [];
  });
  await page.addScriptTag({
    content:
      readFileSync('scripts/factory-ui/issue-store-ui.js', 'utf8') +
      '\n' +
      readFileSync('scripts/factory-ui/issue-capture-ui.js', 'utf8') +
      `
    issueCaptureUI.bind(async (_route, input) => {
      window.submissions.push(input);
      throw Error('Disposable save failure');
    }, async () => {}, {models:[{id:'test', name:'Test'}], defaults:{model:'test'}});`,
  });
  await page.locator('#create-issue').click();
  const grill = page.locator('#capture-grill');
  const skill = page.locator('#capture-grill-skill');
  assert.equal(await grill.isChecked(), false);
  await page.locator('#capture-description').fill('Review the issue before implementation.');
  await grill.check();
  await skill.selectOption('grill-me');
  await page.locator('#capture-issue-store').selectOption('files');
  await page.locator('#capture-grill-skill').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'selection.png') });
  await page.locator('#capture-save').click();
  await page.getByRole('alert').filter({ hasText: 'Disposable save failure' }).waitFor();
  assert.equal(await skill.inputValue(), 'grill-me');
  await page.locator('#capture-save').click();
  const requests = await page.evaluate(() => window.submissions);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((input) => input.grill && input.grillSkill === 'grill-me'));
  assert.equal(requests[0].requestId, requests[1].requestId);
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('factory-capture-draft')));
  assert.equal(draft.grillSkill, 'grill-me');
  writeFileSync(
    join(output, 'proof.json'),
    JSON.stringify(
      {
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        requests,
        draft,
        screenshot: join(output, 'selection.png'),
        assertions: [
          'Dropdown selects grill-me',
          'Creation request retains grill-me',
          'Retry and saved draft retain skill and request identity',
        ],
      },
      null,
      2
    )
  );
  console.log('Passed Create issue grilling selection and retry. Evidence: ' + join(output, 'proof.json'));
} finally {
  await browser.close();
}
