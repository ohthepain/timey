import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importBrowserIssue } from './flow-browser-fixture.mjs';
import { appendMessage } from './factory-ui/conversation-store.mjs';
import { InvestigationReports } from './factory-ui/investigation-reports.mjs';
import { git } from './factory-ui/common.mjs';

export async function investigationReportsBrowserChecks({ page, service, project, poll, screenshot, output }) {
  const calls = [];
  service.projectDiscuss?.close();
  service.projectDiscuss = null;
  service.projectDiscussOptions = {
    modelSettings: () => ({
      defaults: { model: 'fixture', effort: 'high' },
      models: [{ id: 'fixture', name: 'Fixture' }],
      efforts: ['high'],
    }),
    skills: async () => [],
    createProvider: () => ({
      async turn(_session, message) {
        calls.push(message);
        return { text: 'Retained report answer.', suggestion: 'Explain the evidence' };
      },
      async stop() {},
      close() {},
    }),
  };
  const folder = join(project, '.issues/report-browser-originals');
  mkdirSync(folder, { recursive: true });
  const original = join(folder, 'report.md');
  const evidence = join(folder, 'diagram.svg');
  writeFileSync(
    evidence,
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="90"><rect width="400" height="90" fill="#303838"/><text x="15" y="45" fill="white">Retained investigation evidence</text></svg>'
  );
  writeFileSync(
    original,
    '# Executive summary\n\nObserved a concrete improvement.\n\n| Finding | Recommendation |\n| --- | --- |\n| Validation | Add a boundary |\n\n![Evidence diagram](' +
      evidence +
      ')\n\n' +
      Array.from(
        { length: 24 },
        (_, n) => '## Finding ' + n + '\n\nRetained finding and evidence with a bounded recommendation.\n'
      ).join('\n')
  );
  const reports = new InvestigationReports(project);
  const source = {
    issueId: '20261121-report-reader-fixture',
    blockId: 'investigate',
    attemptId: 'run-one',
    startedAt: '2026-11-20T10:00:00Z',
    revision: git(project, 'rev-parse', 'HEAD'),
    findings: 'Retained inquiry findings.',
    evidence: [],
  };
  await importBrowserIssue(
    project,
    source.issueId,
    `---\nid: ${source.issueId}\ntitle: Archived source investigation\nstate: backlog\nrequest_type: investigation\n---\n\nRetained archived inquiry.\n`,
    'archive'
  );
  appendMessage(project, source.issueId, {
    id: 'ordinary-inquiry-result',
    actor: 'agent',
    role: 'Investigate',
    kind: 'flow-block-result',
    body: 'Historical inquiry finding retained by the ordinary flow.',
    blockId: 'investigate',
    source: { attemptId: 'run-one' },
  });
  const first = reports.publish({
    publicationId: 'publication-one',
    attemptId: 'output-one',
    source,
    title: 'First retained report',
    report: original,
    evidence: [{ path: evidence }],
    workspace: project,
  });
  const second = reports.publish({
    publicationId: 'publication-two',
    attemptId: 'output-two',
    source: { ...source, attemptId: 'run-two', startedAt: '2026-11-21T10:00:00Z' },
    title: 'Second retained report',
    report: original,
    evidence: [{ path: 'missing-evidence.txt' }],
    workspace: project,
  });
  reports.publish({
    publicationId: 'unrelated',
    attemptId: 'other-output',
    source: { ...source, issueId: 'unrelated-investigation' },
    title: 'Unrelated report',
    report: original,
    workspace: project,
  });
  const htmlPath = join(folder, 'report.html');
  writeFileSync(htmlPath, editorialReportFixture(evidence));
  const editorial = reports.publish({
    publicationId: 'editorial-publication',
    attemptId: 'editorial-output',
    source,
    title: 'A clearer path forward',
    report: htmlPath,
    evidence: [{ path: evidence }],
    workspace: project,
  });
  rmSync(folder, { recursive: true });
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        window.reportSpeechRecognition = this;
      }
      stop() {
        this.onend?.();
      }
    };
  });
  await page.goto('/?projectTab=reports');
  await page.locator('[data-report-open="' + first.id + '"]').click();
  await page.locator('.report-content table').waitFor();
  assert.equal(await page.locator('.report-discussion-panel').isVisible(), false, 'First visit is reading only.');
  assert.equal(await page.locator('[data-report-run] option').count(), 2, 'Selector contains only this investigation.');
  assert.equal(
    await page
      .locator('[data-report-run]')
      .textContent()
      .then((text) => text.includes('Unrelated')),
    false
  );
  await page.locator('.report-content img').waitFor();
  await poll(
    () => page.locator('.report-content img').evaluate((image) => image.complete && image.naturalWidth > 0),
    (value) => value,
    'The retained diagram did not load after removal of its original.'
  );
  await page.locator('[data-report-discuss]').click();
  await page.locator('#report-discuss-draft').waitFor();
  await page
    .locator('#report-discuss-messages')
    .getByText('Historical inquiry finding retained by the ordinary flow.', { exact: true })
    .waitFor();
  await page.locator('[data-report-prompt]').first().click();
  assert.equal(calls.length, 0, 'Recommended prompt fills without sending.');
  assert.match(await page.locator('#report-discuss-draft').inputValue(), /most important finding/);
  await page.locator('#report-discuss-send').click();
  await page.locator('#report-discuss-messages').getByText('Retained report answer.', { exact: true }).waitFor();
  assert.equal(calls[0].reportContext.reportId, first.id);
  assert.equal(
    service.projectDiscuss.view().conversations.length,
    0,
    'Investigation chat stays outside project histories.'
  );
  const divider = page.locator('.report-divider');
  await divider.focus();
  const before = Number(await divider.getAttribute('aria-valuenow'));
  await divider.press('ArrowUp');
  assert.ok(Number(await divider.getAttribute('aria-valuenow')) < before);
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 25);
  await page.mouse.up();
  assert.equal(await page.locator('#report-discuss-send').isVisible(), true);
  await divider.focus();
  await divider.press('End');
  await page.locator('#report-discuss-draft').focus();
  await page.mouse.move(5, 5);
  const restingColor = await divider.evaluate((node) => getComputedStyle(node).backgroundColor);
  await divider.hover();
  const highlightedColor = await divider.evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.notEqual(highlightedColor, restingColor, 'The thin divider highlights on hover.');
  const minimumSplit = await page.locator('.report-discussion-panel').evaluate((panel) => {
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      panel: rect(panel),
      controls: [
        ...panel.querySelectorAll(
          '#report-discuss-send, #report-discuss-model, #report-discuss-clarification, #report-discuss-mic'
        ),
      ].map((node) => ({ id: node.id, ...rect(node) })),
    };
  });
  assertMinimumSplitControls(minimumSplit);
  saveReaderStyles(output, minimumSplit, { restingColor, highlightedColor });
  await screenshot('investigation-reports-minimum-split');

  await page.locator('#report-discuss-draft').fill('Saved report-specific draft');
  await page.locator('.report-reading').evaluate((node) => {
    node.scrollTop = 240;
    node.dispatchEvent(new Event('scroll'));
  });
  const scroll = await page.locator('.report-reading').evaluate((node) => node.scrollTop);
  await page.locator('[data-report-all]').click();
  const restoringDiscussion = Promise.withResolvers();
  const releaseDiscussion = Promise.withResolvers();
  const resumedDiscussion = Promise.withResolvers();
  const discussionRoute = /\/api\/report-discuss\?/;
  await page.route(discussionRoute, async (route) => {
    restoringDiscussion.resolve();
    await releaseDiscussion.promise;
    await route.continue();
    resumedDiscussion.resolve();
  });
  await page.locator('[data-report-open="' + first.id + '"]').click();
  await restoringDiscussion.promise;
  await page.locator('.report-reading').evaluate((node) => node.dispatchEvent(new Event('scroll')));
  releaseDiscussion.resolve();
  await resumedDiscussion.promise;
  await page.unroute(discussionRoute);
  await poll(
    () => page.locator('#report-discuss-draft').inputValue(),
    (value) => value === 'Saved report-specific draft',
    'Report draft did not restore.'
  );
  writeFileSync(
    join(output, 'report-draft-restore.json'),
    JSON.stringify(
      {
        reportId: first.id,
        restoredDraft: await page.locator('#report-discuss-draft').inputValue(),
        scrollDuringDiscussionLoad: true,
      },
      null,
      2
    ) + '\n'
  );
  assert.ok(
    Math.abs((await page.locator('.report-reading').evaluate((node) => node.scrollTop)) - scroll) < 4,
    'Reading position restores.'
  );
  await page.locator('#report-discuss-draft').fill('');
  await page.locator('#report-discuss-mic').click();
  await page.evaluate(() =>
    window.reportSpeechRecognition.onresult({
      results: [Object.assign([{ transcript: 'Do not send while switching reports go' }], { isFinal: true })],
    })
  );
  await page.locator('[data-report-run]').selectOption(second.id);
  assert.equal(calls.length, 1, 'Leaving a report cancels pending dictated submission.');
  await page.locator('[data-evidence-status="unavailable"]').waitFor();
  await page.locator('.report-content').getByText('Evidence diagram [evidence unavailable]', { exact: true }).waitFor();
  assert.equal(await page.locator('.report-content img').count(), 0, 'Unretained local images are marked unavailable.');
  await page.locator('[data-report-discuss]').click();
  await page.locator('#report-discuss-draft').fill('Question about the second run');
  await page.locator('#report-discuss-send').click();
  await poll(
    () => calls.length,
    (n) => n === 2,
    'The second report question did not send.'
  );
  assert.equal(calls[1].reportContext.reportId, second.id);
  assert.equal(calls[0].reportContext.reportId, first.id, 'Earlier messages retain their original report context.');
  async function dictate(text) {
    await page.locator('#report-discuss-draft').fill('');
    await page.locator('#report-discuss-mic').click();
    await page.evaluate((transcript) => {
      const speech = window.reportSpeechRecognition;
      speech.onresult({ results: [Object.assign([{ transcript }], { isFinal: true })] });
      speech.onend();
    }, text);
  }
  await dictate('Go');
  assert.equal(calls.length, 2, 'Go alone sends nothing.');
  await dictate('Where does go appear inside this sentence');
  assert.equal(calls.length, 2, 'Interior go does not send.');
  await dictate('Explain this report go');
  await poll(
    () => calls.length,
    (n) => n === 3,
    'Spoken send did not submit.'
  );
  assert.equal(calls[2].text, 'Explain this report');
  assert.equal(service.flows.selected(source.issueId).location, 'archive', 'Discussion leaves the source archived.');
  await screenshot('investigation-reports');
  await checkEditorialReport({ page, editorial, poll, screenshot });
  return {
    reportIds: [first.id, second.id],
    sentMessages: calls.map(({ text, reportContext }) => ({ text, reportId: reportContext.reportId })),
    sourceOriginalsRemoved: true,
    minimumSplit,
    dividerColors: { restingColor, highlightedColor },
  };
}

function editorialReportFixture(evidence) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --bg:#FAF9F5; --surface:#FFFFFF; --surface-alt:#F3F1EC; --border:#E6E3DC; --ink:#171717; --ink-soft:#575551; --ink-muted:#85827C; --claude:#D97757; --gemini:#2563EB; --radius-lg:20px; --radius-md:14px; --shadow-sm:0 2px 8px rgba(23,23,23,.03); --shadow-md:0 12px 32px rgba(23,23,23,.05); }
* { box-sizing:border-box; } html { scroll-behavior:smooth; } body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; line-height:1.6; }
.container { max-width:1080px; margin:0 auto; padding:0 24px; } nav { position:sticky; top:0; background:rgba(250,249,245,.85); backdrop-filter:blur(10px); border-bottom:1px solid var(--border); } nav .container { display:flex; justify-content:space-between; align-items:center; min-height:64px; } .brand { font-weight:700; } .dot { display:inline-block; width:10px; height:10px; border-radius:50%; background:linear-gradient(135deg,#D97757,#2563EB); margin-right:8px; } a { color:var(--gemini); } .hero { text-align:center; padding:64px 0; } .pill { display:inline-block; border-radius:99px; padding:5px 12px; background:#ECFDF5; color:#0D7A5F; font-size:.8rem; } h1 { font-size:clamp(2.4rem,5vw,3.6rem); font-weight:800; letter-spacing:-.035em; line-height:1.1; margin:24px 0; } h1 span { color:var(--claude); } .subtitle { font-size:1.2rem; max-width:650px; margin:0 auto 32px; color:var(--ink-soft); } .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr)); gap:20px; text-align:left; } .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-md); padding:24px; box-shadow:var(--shadow-sm); } .label { color:var(--ink-muted); text-transform:uppercase; font-size:.78rem; letter-spacing:.08em; font-weight:600; } .value { display:block; font-size:1.5rem; margin:6px 0; } p { color:var(--ink-soft); } section { padding:64px 0; border-top:1px solid var(--border); } h2 { font-size:clamp(1.75rem,3vw,2.25rem); letter-spacing:-.025em; line-height:1.2; } .feature { border-radius:var(--radius-lg); box-shadow:var(--shadow-md); padding:28px; } .banner { background:var(--ink); color:white; padding:40px; border-radius:var(--radius-lg); } .banner p { color:#B8B5AE; } footer { text-align:center; padding:24px; border-top:1px solid var(--border); color:var(--ink-muted); } @media(max-width:640px) { nav .links { display:none; } .hero { padding:40px 0; } }
</style></head><body>
<nav><div class="container"><span class="brand"><i class="dot"></i>Timey / Investigation</span><a class="links" href="#findings">Read the findings</a></div></nav>
<main class="container"><div class="hero"><span class="pill">✓ Findings retained</span><h1>A <span>clearer</span> path forward.</h1><p class="subtitle">The inquiry found one concrete improvement. Its evidence is saved, and the next step is ready for review.</p><div class="grid">
<div class="card"><span class="label">Finding</span><strong class="value">Validation</strong><p>Add a boundary.</p></div><div class="card"><span class="label">Evidence</span><strong class="value">Retained</strong><p>A saved copy is available.</p></div><div class="card"><span class="label">Source</span><strong class="value">Run one</strong><p>The original inquiry is kept.</p></div><div class="card"><span class="label">Next step</span><strong class="value">Review</strong><p>Decide whether to act.</p></div></div></div>
<section id="findings"><span class="label">What we found</span><h2>Keep the evidence close.</h2><div class="card feature"><h3>Validation needs a boundary</h3><p>The retained inquiry recommends adding a boundary. Review the supporting evidence before starting work.</p><a href="${evidence}">Open evidence</a><p><a href="missing.txt">Missing evidence</a></p></div></section>
<section><div class="banner"><h2>Choose the next step.</h2><p>Review the finding, check its evidence, then decide whether to create an issue.</p></div></section>
<section><h2>Evidence and limits</h2><p>This fixture checks report rendering. It makes no claim about production code.</p></section></main><footer>Investigation report · Run one · Retained publication</footer>
<script>parent.document.body.dataset.reportScriptRan='yes'</script>
<img src="https://example.invalid/report-tracker.png" alt="External resource">
</body></html>`;
}

async function checkEditorialReport({ page, editorial, poll, screenshot }) {
  const externalRequests = [];
  const observe = (request) => {
    if (request.url().includes('example.invalid')) {
      externalRequests.push(request);
    }
  };
  page.on('request', observe);
  await page.locator('[data-report-all]').click();
  await page.locator(`[data-report-open="${editorial.id}"]`).click();
  const frame = page.frameLocator('.report-document');
  await frame.getByRole('heading', { name: 'A clearer path forward.' }).waitFor();
  assert.ok(
    (await page.locator('.report-document').boundingBox()).height > 400,
    'The report uses the available reading height.'
  );
  assert.equal(
    await frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor),
    'rgb(250, 249, 245)'
  );
  assert.equal(await page.locator('body').getAttribute('data-report-script-ran'), null);
  for (const request of externalRequests) {
    assert.equal(await request.response(), null, 'Reports load no external resources.');
    assert.equal(request.failure()?.errorText, 'csp', 'The resource policy blocks external requests.');
  }
  assert.match(
    await frame.getByRole('link', { name: 'Open evidence' }).getAttribute('href'),
    /\/api\/report-evidence\?report=/
  );
  await frame.getByText('Missing evidence [evidence unavailable]', { exact: true }).waitFor();
  await screenshot('investigation-editorial-report');
  await frame.locator('html').evaluate(() => window.scrollTo(0, 300));
  await poll(
    () => frame.locator('html').evaluate(() => window.scrollY),
    (value) => value > 200,
    'HTML report did not scroll.'
  );
  await page.locator('[data-report-all]').click();
  await page.locator(`[data-report-open="${editorial.id}"]`).click();
  await poll(
    () => frame.locator('html').evaluate(() => window.scrollY),
    (value) => value > 200,
    'HTML reading position did not restore.'
  );
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileFrame = await page.locator('.report-document').boundingBox();
  assert.ok(mobileFrame.x + mobileFrame.width <= 390, 'The report frame stays inside the mobile screen.');
  await frame.locator('html').evaluate(() => window.scrollTo(0, 0));
  const widths = await frame
    .locator('html')
    .evaluate((html) => ({ content: html.scrollWidth, viewport: html.clientWidth }));
  assert.ok(widths.content <= widths.viewport, 'The HTML report fits a mobile viewport.');
  assert.equal(await frame.locator('nav .links').isVisible(), false);
  await screenshot('investigation-editorial-report-mobile');
  await page.setViewportSize(viewport);
  page.off('request', observe);
}

function assertMinimumSplitControls(minimumSplit) {
  for (const control of minimumSplit.controls) assertControlBounds(control, minimumSplit.panel);
}
function assertControlBounds(control, panel) {
  assert.ok(control.width > 0 && control.height > 0, control.id + ' has usable dimensions.');
  assert.ok(
    control.top >= panel.top - 1 && control.bottom <= panel.bottom + 1,
    control.id + ' is not vertically clipped.'
  );
  assert.ok(
    control.left >= panel.left - 1 && control.right <= panel.right + 1,
    control.id + ' is not horizontally clipped.'
  );
}

function saveReaderStyles(output, minimumSplit, dividerColors) {
  writeFileSync(
    join(output, 'report-reader-styles.json'),
    JSON.stringify(
      {
        sourceCommit: git(process.cwd(), 'rev-parse', 'HEAD'),
        sourceStatus: git(process.cwd(), 'status', '--porcelain'),
        observedAt: new Date().toISOString(),
        minimumSplit,
        dividerColors,
      },
      null,
      2
    ) + '\n'
  );
}
