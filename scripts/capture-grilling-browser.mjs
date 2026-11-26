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
    window.fetch = async (url) => ({
      ok: true,
      json: async () =>
        url.includes('grilling-skills')
          ? [
              { label: 'Grilling', skill: 'grilling' },
              { label: 'Grill Me', skill: 'grill-me' },
            ]
          : url.includes('folder-default')
            ? { folder: 'Inbox' }
            : ['Inbox'],
    });
    window.submissions = [];
  });
  await page.addScriptTag({
    content:
      readFileSync('scripts/factory-ui/issue-capture-ui.js', 'utf8') +
      `
    issueCaptureUI.bind(async (_route, input) => {
      window.submissions.push(input);
      throw Error('Disposable save failure');
    }, async () => {}, {models:[{id:'test', name:'Test'}], defaults:{model:'test'}});`,
  });
  await page.locator('#create-issue').click();
  assert.equal(await page.getByLabel('Grill me', { exact: true }).isChecked(), false);
  await page.getByLabel('Description', { exact: true }).fill('Review the issue before implementation.');
  await page.getByLabel('Grill me', { exact: true }).check();
  await page.getByLabel('Grilling skill', { exact: true }).selectOption('grill-me');
  await page.locator('#capture-grill-skill').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'selection.png') });
  await page.locator('#capture-save').click();
  await page.getByRole('alert').filter({ hasText: 'Disposable save failure' }).waitFor();
  assert.equal(await page.getByLabel('Grilling skill', { exact: true }).inputValue(), 'grill-me');
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
