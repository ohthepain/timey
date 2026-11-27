import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestData } from './factory-ui/flow-block-data.mjs';
import { createProjectDiscussProvider } from './factory-ui/project-discuss-provider.mjs';

const request = {
  routine: 'Use the existing compact button for Save.',
  unclear: 'Make the reports page work better.',
  ambiguous: '/ui-design Should report details open in a drawer or on the page?',
  decline: 'Skip the prototype and tell me the tradeoff.',
  accept: 'Please prototype the drawer now.',
  feedback: 'Keep the drawer, and return focus to the report after it closes.',
  refine: 'Make the Close button the first focused control.',
  approve: 'That looks right.',
  handoff: 'Create the issue.',
  critique: 'Critique the existing reports page.',
};

const reply = {
  routine: 'Use the same compact Save button as the other forms.',
  unclear: 'Which report task is hard to finish today?',
  ambiguous: 'A prototype would let you compare whether a drawer preserves your place. Would you like one?',
  decline: 'A drawer preserves context. The separate page has more room for details.',
  approve: 'We agreed on the drawer with predictable focus. Should I create an implementation issue?',
  critique: 'The current page gives selection controls too much prominence.',
};

async function prototypeVersion({ project, page }, key, call) {
  const staging = join(project, '.cache/discuss-prototypes');
  mkdirSync(staging, { recursive: true });
  const html = `<!doctype html><title>Report drawer ${key}</title><details><summary>Open report</summary><p>${key}</p></details>`;
  const runnable = join(staging, 'reports.html');
  const screenshot = join(staging, 'reports.png');
  writeFileSync(runnable, html);
  const preview = await page.context().newPage();
  try {
    await preview.goto(pathToFileURL(runnable).href);
    await preview.getByText('Open report').click();
    await preview.screenshot({ path: screenshot });
  } finally {
    await preview.close();
  }
  const {
    files: [file, image],
  } = await call('discuss_prototype_files', { paths: ['reports.html', 'reports.png'] });
  return { html, url: file.url, screenshot: image.url };
}

function captureDescription(agreed) {
  return (
    'Open report details in a drawer\n\nUse a drawer to preserve the report list context. ' +
    'Focus Close on open and restore focus to the initiating report on close.\n\n' +
    'Verify both focus transitions with the keyboard. ' +
    `Download and open the [agreed prototype](${agreed.url}). [Agreed screenshot](${agreed.screenshot}).`
  );
}

function fixtureProvider(context) {
  const { service } = context;
  const fixture = { versions: [], observations: [], issue: null };
  function createProvider() {
    const startThread = ({ developerInstructions, threadId = randomUUID() }) => {
      connection.instructions = developerInstructions;
      return { thread: { id: threadId } };
    };
    const calls = new Map([
      ['skills/list', () => ({ data: [] })],
      ['thread/read', () => ({ thread: { status: { type: 'idle' } } })],
      ['thread/start', startThread],
      ['thread/resume', startThread],
    ]);
    const connection = {
      turns: new Map(),
      async ready() {},
      async call(method, params) {
        assert.ok(calls.has(method), 'Unexpected Discuss request ' + method);
        return calls.get(method)(params);
      },
      async turn(threadId, _root, prompt, _schema, inputs, _settings, receipt) {
        const key = Object.keys(request).find((key) => prompt.includes('Current request:\n' + request[key]));
        assert.ok(key, prompt);
        const turnId = randomUUID();
        this.turns.set(threadId, { started: Promise.resolve({ turn: { id: turnId } }) });
        receipt.accepted({ turnId });
        const tools = [];
        const call = async (tool, args) => {
          tools.push(tool);
          const result = await this.toolHandler({ threadId, turnId, callId: randomUUID(), tool, arguments: args });
          assert.equal(result.success, true, result.contentItems[0].text);
          return JSON.parse(result.contentItems[0].text);
        };
        try {
          assert.match(this.instructions, /"name":"ui-design"/);
          assert.match(this.instructions, /No Grilling/);
          assert.doesNotMatch(this.instructions, /"name":"impeccable"/i);
          const explicit = inputs.some(({ text }) => text?.includes('Selected project skill: ui-design'));
          assert.equal(explicit, key === 'ambiguous');
          fixture.observations.push({ request: request[key], explicit, tools });
          if (['accept', 'feedback', 'refine'].includes(key)) {
            const version = await prototypeVersion(context, key, call);
            fixture.versions.push(version);
            return `Try the [${key} prototype](${version.url}). [Screenshot](${version.screenshot}). Does the drawer work for you?`;
          }
          if (key === 'handoff') {
            const description = captureDescription(fixture.versions.at(-1));
            const issue = await call('issue_create', { description, type: 'feature', requestId: randomUUID() });
            fixture.issue = issue;
            return `Created [the implementation issue](${issue.url}). Work is idle.`;
          }
          return reply[key];
        } finally {
          this.turns.delete(threadId);
        }
      },
      close() {},
    };
    return createProjectDiscussProvider(service, { connection });
  }
  return { fixture, createProvider };
}

async function checkSavedIssue({ page, service, output, screenshot }, fixture) {
  const id = fixture.issue.issueId;
  const issue = service.flows.selected(id);
  const flow = service.flows.read(issue);
  const wording = requestData(flow).wording;
  assert.match(wording, /preserve the report list context/);
  assert.match(wording, /Focus Close on open and restore focus/);
  assert.ok(flow.blocks.filter(({ kind }) => kind !== 'request').every(({ attempts }) => !attempts.length));
  const savedLink = wording.match(/\[agreed prototype\]\(([^)]+)\)/)?.[1];
  assert.equal(savedLink, fixture.versions.at(-1).url);
  for (const { html, url, screenshot: imageUrl } of fixture.versions) {
    const response = await page.request.get(url);
    assert.ok(response.ok());
    assert.match(response.headers()['content-disposition'], /^attachment;.*reports.html$/);
    assert.equal(await response.text(), html);
    const image = await page.request.get(imageUrl);
    assert.equal(image.headers()['content-type'], 'image/png');
    assert.match(image.headers()['content-disposition'], /^inline;.*reports.png$/);
  }
  await page.goto(fixture.issue.url);
  await page.locator('#issue-title').getByText(issue.title, { exact: true }).waitFor();
  await page.locator('#open-issue-report').click();
  const report = page.getByRole('dialog', { name: 'Issue report' });
  assert.equal(
    await report.getByRole('link', { name: 'Agreed screenshot' }).getAttribute('href'),
    fixture.versions.at(-1).screenshot
  );
  const downloadLink = report.getByRole('link', { name: 'agreed prototype' });
  assert.equal(await downloadLink.getAttribute('href'), savedLink);
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
  assert.equal(download.suggestedFilename(), 'reports.html');
  const downloaded = join(output, 'discuss-agreed-prototype.html');
  await download.saveAs(downloaded);
  assert.equal(readFileSync(downloaded, 'utf8'), fixture.versions.at(-1).html);
  const reopened = await page.context().newPage();
  try {
    await reopened.goto(pathToFileURL(downloaded).href);
    await reopened.getByText('Open report').click();
    assert.equal(await reopened.getByText('refine', { exact: true }).isVisible(), true);
    await reopened.screenshot({ path: join(output, 'discuss-ui-design-reopened.png') });
  } finally {
    await reopened.close();
  }
  await screenshot('discuss-ui-design-report');
  return { id, wording, route: flow.routeType, workAttempts: 0 };
}

export async function discussUiDesignBrowserChecks({ page, service, project, poll, screenshot, output }) {
  const { fixture, createProvider } = fixtureProvider({ project, service, page });
  const previous = service.projectDiscussOptions;
  service.projectDiscuss?.close();
  service.projectDiscuss = null;
  service.projectDiscussOptions = {
    ...previous,
    skills: undefined,
    createProvider,
  };
  const send = async (key, expected) => {
    const draft = page.locator('#discuss-draft');
    if (key === 'ambiguous') {
      await draft.fill('/ui-design');
      await page.locator('#discuss-form .skill-option').filter({ hasText: 'ui-design' }).click();
      await draft.pressSequentially(request[key].slice('/ui-design '.length));
    } else await draft.fill(request[key]);
    await page.locator('#discuss-send[data-discuss-action="send"]').click();
    await page.locator('#discuss-messages').getByText(expected, { exact: false }).waitFor();
    await poll(
      () => service.projectDiscuss.view(new URL(page.url()).searchParams.get('conversation')).selected?.status,
      (status) => status === 'idle',
      'Design message did not finish.'
    );
    assert.equal(await page.locator('#discuss-suggestion').isVisible(), false);
  };
  const conversation = () => new URL(page.url()).searchParams.get('conversation');
  const start = async () => {
    const previous = conversation();
    await page.locator('#discuss-new').click();
    await poll(conversation, (id) => id && id !== previous, 'New design conversation did not open.');
  };
  try {
    const issuesBefore = service.flows.issues().length;
    await page.goto('/');
    await page.locator('#project-tab-discuss').click();
    await start();
    await send('routine', reply.routine);
    await send('unclear', reply.unclear);
    await send('critique', reply.critique);
    await start();
    await send('ambiguous', reply.ambiguous);
    await send('decline', reply.decline);
    assert.equal(fixture.versions.length, 0);
    await send('accept', 'accept prototype');
    await send('feedback', 'feedback prototype');
    await send('refine', 'refine prototype');
    await send('approve', reply.approve);
    assert.equal(service.flows.issues().length, issuesBefore);
    await send('handoff', 'Work is idle.');
    assert.equal(service.flows.issues().length, issuesBefore + 1);
    await page.reload();
    const savedChatLink = page.locator('#discuss-messages').getByRole('link', { name: 'refine prototype' });
    await savedChatLink.waitFor();
    assert.ok((await savedChatLink.getAttribute('href')).endsWith(fixture.versions.at(-1).url));
    await screenshot('discuss-ui-design-handoff');
    const issue = await checkSavedIssue({ page, service, output, screenshot }, fixture);
    writeFileSync(
      join(output, 'discuss-ui-design.json'),
      JSON.stringify(
        {
          provider: 'Scripted replies and tool choices through the real Project Discuss provider',
          composerSuggestions: 'Absent for all messages',
          conversations: fixture.observations,
          issueCountBeforeHandoff: issuesBefore,
          issueCountAfterHandoff: issuesBefore + 1,
          issue,
          retainedVersions: fixture.versions,
        },
        null,
        2
      ) + '\n'
    );
  } finally {
    service.projectDiscuss.close();
    service.projectDiscuss = null;
    service.projectDiscussOptions = previous;
  }
}
