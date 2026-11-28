import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve('@playwright/cli/package.json'));
const { chromium } = playwrightRequire('playwright');

test('the issue dialog shows wrapped status text at a narrow viewport', async () => {
  const html = readFileSync(new URL('./factory-ui/project-issues.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./factory-ui/project-issues.css', import.meta.url), 'utf8');
  const dialogMarkup = html.match(/<dialog id="archive-progress"[\s\S]*?<\/dialog>/)[0];
  const message =
    'This permanently deletes the listed issues and any evidence Factory verifies is no longer referenced. Evidence still in use is kept.';
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 600 } });
    await page.setContent(`<!doctype html><style>${css}</style>${dialogMarkup}`);
    const status = page.getByRole('status', { includeHidden: true });
    await status.evaluate((node, text) => {
      node.textContent = text;
      node.closest('dialog').showModal();
    }, message);

    const layout = await status.evaluate((node) => {
      const text = new Range();
      text.selectNodeContents(node);
      return {
        textBottom: text.getBoundingClientRect().bottom,
        statusBottom: node.getBoundingClientRect().bottom,
        dialogBottom: node.closest('dialog').getBoundingClientRect().bottom,
      };
    });
    assert.ok(layout.textBottom <= Math.min(layout.statusBottom, layout.dialogBottom), JSON.stringify(layout));
    await page.getByRole('button', { name: 'Dismiss' }).click();
    assert.equal(await page.getByRole('dialog').isVisible(), false);
  } finally {
    await browser.close();
  }
});
