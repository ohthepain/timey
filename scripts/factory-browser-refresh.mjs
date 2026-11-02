export default async function refreshStateChecks(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let revision = 0;
  const conversation = {
    issueId: 'b',
    hasMore: false,
    messages: Array.from({ length: 40 }, (_, index) => ({
      id: 'message-' + index,
      at: new Date(100000 + index * 1000).toISOString(),
      actor: 'human',
      body: ('Saved message ' + index + '. ').repeat(40),
    })),
  };
  await page.route('**/api/queue?**', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.issues.find((issue) => issue.id === 'b').updated = 'refresh-' + revision;
    snapshot.runs.push({
      id: 'refresh-worker',
      threadId: 'synthetic-refresh-chat',
      issueId: 'b',
      issueState: 'backlog',
      kind: 'worker',
      status: 'blocked',
      connected: false,
      created: '2026-10-28',
      summary: 'Disposable stopped worker',
      events: [],
      output: [],
      approvals: [],
    });
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/issue-chat?**', (route) => route.fulfill({ json: conversation }));
  await page.goto(new URL('/#/issue/b', page.url()).href);
  await page.getByRole('heading', { name: 'Older urgent issue', exact: true }).waitFor();
  await page.locator('[data-chat-tab="issue"]').click();
  await page.waitForFunction(
    () => document.getElementById('error').textContent || document.querySelector('[aria-label="Issue conversation"]')
  );
  const error = await page.locator('#error').textContent();
  if (error) throw Error('Fixture render failed: ' + error);
  const log = page.getByRole('log', { name: 'Issue conversation', exact: true });
  await log.getByText(conversation.messages[0].body, { exact: true }).waitFor();
  const ordinary = page.locator('#strategy-instruction');
  const ancestors = ordinary.locator('xpath=ancestor::details');
  for (const ancestor of await ancestors.all()) {
    if (!(await ancestor.evaluate((element) => element.open))) await ancestor.locator(':scope > summary').click();
  }
  await ordinary.fill(Array.from({ length: 80 }, (_, i) => 'Worker draft line ' + i).join('\n'));
  const ordinaryBefore = await ordinary.evaluate((field) => {
    field.setSelectionRange(field.value.length, field.value.length);
    field.scrollTop = 120;
    return { value: field.value, top: field.scrollTop };
  });
  await ordinary.blur();
  revision++;
  await page.evaluate(async () => {
    await refresh();
  });
  const ordinaryAfter = await ordinary.evaluate((field) => ({ value: field.value, top: field.scrollTop }));
  if (
    ordinaryBefore.top <= 0 ||
    ordinaryBefore.value !== ordinaryAfter.value ||
    ordinaryBefore.top !== ordinaryAfter.top
  )
    throw Error('Ordinary textarea lost its draft or internal scroll');
  const draft = page.getByRole('textbox', { name: 'Chat input', exact: true });
  const text = Array.from({ length: 80 }, (_, i) => 'Draft line ' + i).join('\n');
  await draft.fill(text);
  await draft.evaluate((field) => {
    field.setSelectionRange(field.value.length, field.value.length);
    field.scrollTop = 120;
    field.scrollLeft = 0;
  });
  await log.evaluate((element) => {
    element.scrollTop = 150;
  });
  const before = await draft.evaluate((field) => ({ top: field.scrollTop, start: field.selectionStart }));
  async function refresh(changed) {
    if (changed) revision++;
    await page.evaluate(async () => {
      await refresh();
    });
  }
  async function assertReading(label) {
    const state = await page.evaluate(() => {
      const log = document.querySelector('[aria-label="Issue conversation"]');
      const field = document.querySelector('[data-chat-panel="issue"] [aria-label="Chat input"]');
      return {
        top: log.scrollTop,
        draftTop: field.scrollTop,
        value: field.value,
        focused: document.activeElement === field,
        start: field.selectionStart,
      };
    });
    if (
      Math.abs(state.top - 150) > 1 ||
      Math.abs(state.draftTop - before.top) > 1 ||
      state.value !== text ||
      !state.focused ||
      state.start !== before.start
    )
      throw Error(label + ': ' + JSON.stringify(state));
  }
  await refresh(false);
  await assertReading('unchanged polling');
  await refresh(true);
  await assertReading('changed polling');
  conversation.messages.push({ id: 'new-message', at: '2026-10-28', actor: 'agent', body: 'New incoming output' });
  await refresh(true);
  await assertReading('incoming message while reading');
  await draft.evaluate((field) => {
    field.setSelectionRange(6, 20, 'backward');
    field.scrollTop = 120;
  });
  const pageTop = await page.evaluate(() => window.scrollY);
  await refresh(true);
  const caret = await draft.evaluate((field) => [
    field.selectionStart,
    field.selectionEnd,
    field.selectionDirection,
    field.scrollTop,
  ]);
  if (JSON.stringify(caret) !== JSON.stringify([6, 20, 'backward', 120]))
    throw Error('Draft selection or scroll was lost');
  if (Math.abs((await page.evaluate(() => window.scrollY)) - pageTop) > 1) throw Error('Page scroll was lost');
  await log.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  conversation.messages.push({
    id: 'last-message',
    at: '2026-10-29',
    actor: 'agent',
    body: 'Latest output\n'.repeat(30),
  });
  await refresh(true);
  const following = await log.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2
  );
  if (!following) throw Error('Reader at bottom stopped following incoming output');
  await draft.blur();
  const selected = await log.evaluate((element) => {
    const text = element.querySelector('article p').firstChild;
    const selection = window.getSelection();
    selection.setBaseAndExtent(text, 2, text, 18);
    return selection.toString();
  });
  await refresh(true);
  if ((await page.evaluate(() => window.getSelection().toString())) !== selected)
    throw Error('Refreshing lost selected conversation text');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const details = page.locator('.issue-step[data-stage-state="qa"]');
  for (const ancestor of await details.locator('xpath=ancestor::details').all()) {
    if (!(await ancestor.evaluate((element) => element.open))) await ancestor.locator(':scope > summary').click();
  }
  {
    const summary = details.locator(':scope > summary');
    if (!(await details.evaluate((element) => element.open))) await summary.click();
    await refresh(true);
    if (!(await details.evaluate((element) => element.open))) throw Error('Expanded stage collapsed');
  }
  await page.screenshot({ path: 'refresh-state.png', fullPage: false });
  await page.unroute('**/api/queue?**');
  await page.unroute('**/api/issue-chat?**');
  if (errors.length) throw Error(errors.join('; '));
  return {
    passed: true,
    assertions: [
      'unchanged polling',
      'changed polling',
      'scrolled conversation',
      'textarea scroll with caret at end',
      'draft and focus',
      'ordinary textarea draft and scroll',
      'selection',
      'backward textarea selection',
      'page scroll',
      'incoming content',
      'bottom following',
      'expanded sections',
      'no page errors',
    ],
  };
}
