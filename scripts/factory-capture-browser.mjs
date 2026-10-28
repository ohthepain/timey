import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { captureFixture, proposal } from './factory-capture-fixture.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';

const evidence = mkdtempSync(join(tmpdir(), 'timey-capture-browser-'));
const output = join(evidence, 'output/playwright');
mkdirSync(output, { recursive: true });
const cleanup = [];
let assessments = 0;
const { root, service } = captureFixture(
  { after: (fn) => cleanup.push(fn) },
  {
    assess: async (text) => {
      assessments++;
      await new Promise((resolve) => setTimeout(resolve, text.includes('slow') ? 4800 : 100));
      if (text.includes('retry') && assessments === 1) throw Error('Disposable provider failure');
      const parts = text.includes('two outcomes') ? ['two outcomes', 'copy ID'] : [text];
      return { issues: parts.map((part) => proposal(part)) };
    },
  }
);
for (let i = 0; i < 40; i++)
  writeFileSync(
    join(root, `.issues/20261025-row${i}.md`),
    `---\nid: 20261025-row${i}\ntitle: Existing row ${i}\nstate: backlog\n---\nFixture\n`
  );
const ledger = readFileSync(join(root, '.issues/factory.json'), 'utf8');
for (const name of ['launch', 'startLifecycle', 'progressStart', 'integrate', 'evaluate'])
  service[name] = () => {
    throw Error('Unexpected work: ' + name);
  };
const server = createFactoryServer(service);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const cli = join(homedir(), '.codex/skills/playwright/scripts/playwright_cli.sh');
const commands = [];
async function run(label, ...args) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(cli, ['--session', 'capture-1aab', ...args], { cwd: output, env: process.env });
    let text = '';
    child.stdout.on('data', (s) => {
      text += s;
    });
    child.stderr.on('data', (s) => {
      text += s;
    });
    child.on('error', reject);
    child.on('exit', (exit) => resolve({ exit, text }));
  });
  const log = join(output, label + '.log');
  writeFileSync(log, result.text);
  commands.push({ label, args, exit: result.exit, log });
  writeFileSync(join(evidence, 'commands.json'), JSON.stringify(commands, null, 2));
  assert.equal(result.exit, 0, label + ': ' + result.text);
  assert.ok(!result.text.includes('### Error'), label + ': ' + result.text);
  return result.text;
}
async function scenario(label, body) {
  await run(label + '-snapshot', 'snapshot');
  const file = join(output, label + '.js');
  writeFileSync(
    file,
    `async (page) => { const errors=[], network=[]; page.on('pageerror', e=>errors.push(e.message)); page.on('response',r=>network.push({url:r.url(),status:r.status()})); const check=(value,label)=>{if(!value)throw Error(label)}; ${body}; check(errors.length===0, 'Browser page errors: '+errors.join(';')); return {errors,network}; }`
  );
  return run(label, 'run-code', '--filename', file);
}
try {
  await run('open', 'open', url);
  await scenario(
    'cancel-and-failure',
    `
    await page.getByRole('button',{name:'Create issue',exact:true}).waitFor();
    await page.getByRole('button',{name:'Create issue',exact:true}).click();
    check(await page.getByLabel('Description',{exact:true}).evaluate(e=>e===document.activeElement),'Initial focus');
    await page.getByLabel('Description',{exact:true}).fill('Never saved');
    await page.keyboard.press('Escape');
    check(await page.locator('#create-issue-dialog').evaluate(e=>!e.open),'Escape closes dialog');
    await page.getByRole('button',{name:'Create issue',exact:true}).click();
    await page.getByLabel('Description',{exact:true}).fill('retry capture');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.locator('#capture-error').filter({hasText:'Disposable provider failure'}).waitFor();
    check(await page.getByLabel('Description',{exact:true}).inputValue()==='retry capture','Draft retained after failure');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.locator('#capture-toast a').waitFor();
    check(page.url().endsWith('/'),'Save remains on queue');
    await page.locator('#capture-toast a').click();
    await page.locator('h1').filter({hasText:'Capture retry capture'}).waitFor();
    await page.goBack();
  `
  );
  await scenario(
    'polling-multiple-and-preservation',
    `
    await page.getByRole('button',{name:'Create issue',exact:true}).waitFor();
    await page.getByLabel('Search issues',{exact:true}).fill('Existing');
    await page.getByLabel('Filter by stage',{exact:true}).selectOption('backlog');
    await page.evaluate(()=>window.scrollTo(0,700));
    const before=await page.evaluate(()=>window.scrollY);
    await page.locator('#create-issue').evaluate(e=>e.click());
    await page.getByLabel('Description',{exact:true}).fill('slow two outcomes\\ncopy ID');
    await page.waitForTimeout(4300);
    check(await page.getByLabel('Description',{exact:true}).inputValue()==='slow two outcomes\\ncopy ID','Polling retains draft');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    check(await page.locator('#capture-save').isDisabled(),'Save disabled while pending');
    await page.locator('#capture-form').evaluate(e=>e.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    check(await page.locator('#capture-cancel').isDisabled(),'Cancel disabled during publication');
    await page.keyboard.press('Escape');
    check(await page.locator('#create-issue-dialog').evaluate(e=>e.open),'Escape cannot pretend to cancel submitted capture');
    await page.locator('#capture-toast a').nth(1).waitFor();
    await page.waitForFunction(()=>!document.querySelector('#create-issue-dialog').hasAttribute('aria-busy'));
    check(await page.getByLabel('Search issues',{exact:true}).inputValue()==='Existing','Search preserved');
    check(await page.getByLabel('Filter by stage',{exact:true}).inputValue()==='backlog','Stage filter preserved');
    check(Math.abs(await page.evaluate(()=>window.scrollY)-before)<5,'Window scroll preserved: '+before+' -> '+await page.evaluate(()=>window.scrollY));
    check(!page.url().includes('/issue/'),'Multiple capture stays on queue');
    await page.screenshot({path:${JSON.stringify(join(output, 'desktop.png'))},fullPage:false});
    await page.locator('#capture-toast a').nth(1).click();
    await page.locator('h1').filter({hasText:'Capture copy ID'}).waitFor();
    await page.goBack();
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Create issue',exact:true}).click();
    await page.getByLabel('Description',{exact:true}).fill('<script>data only</script>');
    await page.screenshot({path:${JSON.stringify(join(output, 'narrow.png'))}});
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
  `
  );
  await scenario(
    'lost-response-and-refresh-failure',
    `
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'Create issue',exact:true}).click();
    await page.getByLabel('Description',{exact:true}).fill('Recover a lost response');
    await page.route('**/api/issue-capture', async route=>{ await route.fetch(); await route.abort(); });
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.locator('#capture-error').filter({hasText:'Retry Save'}).waitFor();
    await page.unroute('**/api/issue-capture');
    await page.reload();
    await page.getByRole('button',{name:'Create issue',exact:true}).click();
    check(await page.getByLabel('Description',{exact:true}).inputValue()==='Recover a lost response','Reload retains failed request draft');
    await page.route('**/api/queue*', route=>route.abort());
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.locator('#capture-toast a').filter({hasText:'Recover a lost response'}).waitFor();
    check(await page.locator('#create-issue-dialog').evaluate(e=>!e.open),'Recovered response closes dialog despite refresh failure');
    await page.unroute('**/api/queue*');
  `
  );
  assert.equal(readFileSync(join(root, '.issues/factory.json'), 'utf8'), ledger);
  assert.equal(service.store.runs.length, 0);
  assert.equal(readdirSync(join(root, '.issues')).filter((n) => /^\d.*\.md$/.test(n)).length, 45);
  const proof = {
    passed: true,
    url,
    assessments,
    noWorkRuns: true,
    registryPreserved: true,
    lostResponseRecovered: true,
    refreshFailureRetainsLinks: true,
    reports: readdirSync(join(root, '.issues')).filter((n) => /^\d.*\.md$/.test(n)),
  };
  writeFileSync(join(evidence, 'assertions.json'), JSON.stringify(proof, null, 2));
  console.log(evidence);
} finally {
  await run('close', 'close').catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  for (const close of cleanup.reverse()) await close();
}
