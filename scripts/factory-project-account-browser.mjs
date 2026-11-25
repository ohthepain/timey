import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { FactoryUI } from './factory-ui/service.mjs';

if (process.argv[2] === '--fixture') {
  await checkAccount(process.argv[3]);
} else {
  try {
    execFileSync('python3', ['scripts/auth-fixture.py', '--factory-account'], { stdio: 'inherit' });
  } catch (error) {
    process.exitCode = error.status || 1;
  }
}

async function checkAccount(output) {
  const { base } = JSON.parse(readFileSync(join(output, 'browser-target.json'), 'utf8'));
  const project = join(output, 'project');
  mkdirSync(join(project, '.issues'), { recursive: true });
  git(project, 'init', '-q', '-b', 'dev');
  git(
    project,
    '-c',
    'user.name=Factory fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'Fixture'
  );

  const service = new FactoryUI(project, { preview: true });
  const factory = createFactoryServer(service, { projectAccountOrigin: base });
  let browser;
  try {
    factory.listen(0, '127.0.0.1');
    await once(factory, 'listening');
    const factoryOrigin = `http://127.0.0.1:${factory.address().port}`;
    const require = createRequire(import.meta.url);
    const playwrightRequire = createRequire(require.resolve('@playwright/cli/package.json'));
    const { chromium } = playwrightRequire('playwright');
    browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const evidence = await exerciseAccount(page, { base, factoryOrigin, output });
    const path = join(output, 'project-account.json');
    writeFileSync(
      path,
      JSON.stringify({ revision: git(process.cwd(), 'rev-parse', 'HEAD'), ...evidence }, null, 2) + '\n'
    );
    console.log(`Factory account browser evidence: ${path}`);
  } finally {
    await browser?.close();
    service.close();
    if (factory.listening) await new Promise((resolve) => factory.close(resolve));
  }
}

async function exerciseAccount(page, { base, factoryOrigin, output }) {
  const user = {
    username: 'factoryfixture',
    name: 'Factory fixture',
    email: 'factory-fixture@example.test',
    password: 'Disposable-factory-password-123!',
  };
  const signup = await fetch(base + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  });
  assert.equal(signup.status, 200, 'The fixture created a real disposable Timey account');
  const frameNavigation = [];
  const framePath = base + '/auth/factory-account?';
  const [frameResponse] = await Promise.all([
    page.waitForResponse((response) => {
      if (!response.url().startsWith(framePath)) return false;
      const status = response.status();
      frameNavigation.push({ status, location: response.headers().location });
      return status < 300 || status >= 400;
    }),
    page.goto(factoryOrigin),
  ]);
  assert.ok(frameResponse.ok(), `Timey's account frame returned HTTP ${frameResponse.status()}`);
  assert.equal(frameResponse.headers()['content-security-policy'], `frame-ancestors ${factoryOrigin}`);
  const account = page.frameLocator('iframe[title="Timey account"]');
  const login = account.getByRole('link', { name: 'Login', exact: true });
  await login.waitFor();
  await page.screenshot({ path: join(output, 'project-account-signed-out.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await checkNarrowHeader(page, login);
  await page.screenshot({ path: join(output, 'project-account-narrow-signed-out.png') });
  const [loginPage] = await Promise.all([page.waitForEvent('popup'), login.click()]);
  assert.equal(new URL(loginPage.url()).origin, base, 'Login opens the target Timey server');
  assert.equal(new URL(loginPage.url()).pathname, '/auth/login');
  await loginPage.getByLabel('Username or email').fill(user.username);
  await loginPage.getByLabel('Password', { exact: true }).fill(user.password);
  await loginPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signedInText = await loginPage.getByText(/^Signed in as/).innerText();
  assert.ok(signedInText.includes(user.name), 'Timey confirmed the display name for the signed-in fixture');
  await loginPage.close();

  await openAccountMenu(account, user.name, output);
  const accountLink = account.getByRole('link', { name: 'Account', exact: true });
  const signOut = account.getByRole('button', { name: 'Sign out', exact: true });
  await page.waitForFunction(() => Number(document.querySelector('iframe[title="Timey account"]').height) > 40);
  const menuBounds = await Promise.all([accountLink, signOut].map(visibleMenuItemBounds));
  await page.screenshot({ path: join(output, 'project-account-narrow-signed-in.png') });
  const [accountPage] = await Promise.all([page.waitForEvent('popup'), accountLink.click()]);
  assert.equal(new URL(accountPage.url()).origin, base);
  assert.equal(new URL(accountPage.url()).pathname, '/auth/session');
  await accountPage.getByText(/^Signed in as/).waitFor();
  await accountPage.close();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: join(output, 'project-account-signed-in.png') });

  await signOut.click();
  await login.waitFor();
  return {
    factoryOrigin,
    projectOrigin: base,
    frameNavigation,
    framePolicy: frameResponse.headers()['content-security-policy'],
    signedOut: 'Login opens the target Timey login screen',
    signedIn: 'The Timey account menu displays the real signed-in user and opens the account page',
    signOut: 'Signing out from the header restores Login',
    narrow,
    menuBounds,
  };
}

async function visibleMenuItemBounds(item) {
  const bounds = await item.evaluate((element) => {
    const { top, right, bottom, left } = element.getBoundingClientRect();
    return { top, right, bottom, left, width: window.innerWidth, height: window.innerHeight };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, 'The account menu item fits the frame horizontally');
  assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height, 'The account menu item fits the frame vertically');
  return bounds;
}

async function openAccountMenu(account, name, output) {
  try {
    await account.getByRole('button', { name, exact: true }).click({ timeout: 12000 });
  } catch (error) {
    const state = await account.locator('main').evaluate(async (main) => {
      const response = await fetch('/api/auth/get-session');
      const session = await response.json();
      return { text: main.textContent, status: response.status, signedIn: Boolean(session?.user) };
    });
    const path = join(output, 'project-account-session-diagnostic.json');
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
    console.error(`Factory account session diagnostic: ${path}`, state);
    throw error;
  }
}

async function checkNarrowHeader(page, login) {
  const header = await page.getByRole('banner', { name: 'Factory' }).boundingBox();
  const frame = await page.getByTitle('Timey account').boundingBox();
  assert.ok(header);
  assert.ok(frame);
  const rightGap = header.x + header.width - (frame.x + frame.width);
  assert.ok(rightGap >= 0 && rightGap <= 24, 'The Timey account stays at the right edge of the narrow header');

  const tabs = page.getByRole('tablist', { name: 'Project workspace' });
  const order = ['Home', 'Issues', 'Reports', 'Discuss', 'Automate me', 'Admin'];
  assert.deepEqual(
    (await tabs.getByRole('tab').allTextContents()).map((label) => label.trim()),
    order
  );
  for (const name of order) {
    await tabs.getByRole('tab', { name, exact: true }).click();
    await tabs.getByRole('tab', { name, exact: true, selected: true }).waitFor();
    await login.waitFor();
  }
  await tabs.getByRole('tab', { name: 'Home', exact: true }).click();
  return { header, frame, rightGap, tabs: order };
}
