import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { storedIssuePath } from './factory-ui/issue-report-storage.mjs';
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
  const archivedSource = storedIssuePath(project, source.issueId, 'archive');
  mkdirSync(dirname(archivedSource), { recursive: true });
  writeFileSync(
    archivedSource,
    `---\nid: ${source.issueId}\ntitle: Archived source investigation\nstate: backlog\nrequest_type: investigation\n---\n\nRetained archived inquiry.\n`
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
  return {
    reportIds: [first.id, second.id],
    sentMessages: calls.map(({ text, reportContext }) => ({ text, reportId: reportContext.reportId })),
    sourceOriginalsRemoved: true,
    minimumSplit,
    dividerColors: { restingColor, highlightedColor },
  };
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
