"""Rendered auth flows through Playwright CLI, using only the owning fixture's target."""
import email
import email.policy
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]).resolve()
TARGET = json.loads((OUT / 'browser-target.json').read_text())
BASE = TARGET['base']
ARTIFACTS = OUT / 'output' / 'playwright'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
CLI = Path(os.environ.get('PWCLI', str(Path.home() / '.codex/skills/playwright/scripts/playwright_cli.sh')))
COMMANDS = []
CHECKS = {}


def command(label, args, cwd=ROOT):
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT)
    log = ARTIFACTS / (label + '.log')
    log.write_text(result.stdout)
    COMMANDS.append({'command': args, 'exit': result.returncode, 'log': str(log)})
    (OUT / 'browser-commands.json').write_text(json.dumps(COMMANDS, indent=2))
    if result.returncode or '### Error' in result.stdout:
        raise RuntimeError(f'{label} failed: {log}')
    return result.stdout


def cli(label, *args, session='a'):
    return command(label, [str(CLI), '--session', 'timey-f50-' + session, *args], cwd=ARTIFACTS)


def code(label, body, session='a'):
    source = '''async (page) => {
      const base = BASE;
      const check = (condition, label) => { if (!condition) throw new Error(label); };
      const visible = async text => page.getByText(text === 'Signed in as' ? /^Signed in as/ : text, { exact: true }).waitFor();
      const fill = async (label, value) => page.getByLabel(label, { exact: true }).fill(value);
      const password = 'Disposable-browser-password-123!';
      const changed = 'Changed-browser-password-456!';
      const login = async (identifier, secret = password, remember = true) => {
        await page.goto(base + '/auth/login');
        await fill('Username or email', identifier); await fill('Password', secret);
        await page.getByLabel('Remember me').setChecked(remember);
        await page.getByRole('button', {name: 'Sign in', exact: true}).click();
      };
      const network = [], consoleMessages = [], pageErrors = [];
      const onResponse = response => network.push({method:response.request().method(),url:response.url(),status:response.status()});
      const onConsole = message => consoleMessages.push({type:message.type(),text:message.text()});
      const onError = error => pageErrors.push(error.message);
      page.on('response',onResponse); page.on('console',onConsole); page.on('pageerror',onError);
      const assertions = await (async () => { BODY })();
      page.off('response',onResponse); page.off('console',onConsole); page.off('pageerror',onError);
      return {assertions,network,console:consoleMessages,pageErrors};
    }'''.replace('BASE', json.dumps(BASE)).replace('BODY', body)
    file = ARTIFACTS / (label + '.js')
    file.write_text(source)
    output = cli(label, 'run-code', '--filename', str(file), session=session)
    match = re.search(r'### Result\n(.*?)\n###', output, re.S)
    value = json.loads(match.group(1)) if match else None
    CHECKS[label] = value if value is not None else True
    (OUT / 'browser-assertions.json').write_text(json.dumps(CHECKS, indent=2))
    return value


def sql(label, statement):
    return command(label, ['psql', TARGET['database'], '-v', 'ON_ERROR_STOP=1', '-Atc', statement]).strip()


def reset_link(number):
    message = email.message_from_bytes((OUT / f'mail-{number}.eml').read_bytes(), policy=email.policy.default)
    return re.search(r'http://[^\s]+', message.get_content()).group(0)


try:
    cli('open-a', 'open', BASE + '/auth/signup')
    cli('signup-initial', 'snapshot')
    code('signup-validation', '''
      await page.goto(base + '/auth/signup'); await page.waitForLoadState('networkidle');
      await fill('Username', 'screenfixture'); await fill('Email', 'invalid');
      await fill('Password', password); await fill('Confirm password', password);
      await page.getByRole('button', {name:'Create your account', exact:true}).click();
      check(await page.getByLabel('Email', {exact:true}).evaluate(el => !el.validity.valid), 'email validation');
      await fill('Email', 'screenfixture@example.test'); await fill('Password', 'short');
      await page.getByRole('button', {name:'Create your account', exact:true}).click();
      check(await page.getByLabel('Password', {exact:true}).evaluate(el => !el.validity.valid), 'password length validation');
      await fill('Password', password); await fill('Confirm password', 'Different-password-123!');
      await page.getByRole('button', {name:'Create your account', exact:true}).click();
      await visible('Passwords do not match.');
      await fill('Username', 'invalid username'); await fill('Confirm password', password);
      await page.getByRole('button', {name:'Create your account', exact:true}).click();
      await page.getByRole('alert').waitFor();
      check((await page.getByRole('alert').innerText()) !== 'Passwords do not match.', 'library username validation');
      return {emailValidation:true, confirmationValidation:true, passwordLengthValidation:true, usernameValidation:true};
    ''')
    code('signup-success', '''
      await fill('Username', 'screenfixture');
      await page.getByRole('button', {name:'Create your account', exact:true}).click();
      await visible('Signed in as');
      check(await page.getByText('screenfixture', {exact:true}).isVisible(), 'initial display name');
      check(!(await page.locator('main').innerText()).includes('screenfixture@example.test'), 'private email');
      const cookies = await page.context().cookies();
      const cookie = cookies.find(c => c.name.includes('session_token'));
      check(cookie.httpOnly && cookie.sameSite === 'Lax' && cookie.expires > Date.now()/1000, 'persistent HttpOnly cookie');
      await page.reload(); await visible('Signed in as');
      return {signup:true, displayName:true, privateEmail:true, cookie, reload:true};
    ''')
    cli('signed-in', 'screenshot', '--filename', str(ARTIFACTS / 'signed-in.png'))
    check_id = sql('browser-id', "SELECT id FROM auth.user WHERE username='screenfixture'")
    assert sql('profile-lazy', f'''SELECT count(*) FROM domain."User" WHERE id='{check_id}' ''') == '0'
    sql('browser-fail-profile', '''CREATE FUNCTION domain.browser_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'disposable browser failure'; END $$;
      CREATE TRIGGER browser_fail BEFORE INSERT ON domain."User" FOR EACH ROW EXECUTE FUNCTION domain.browser_fail();''')
    code('profile-fails-closed', '''
      const response = await page.evaluate(() => fetch('/api/session').then(r => r.status));
      check(response === 503, 'profile failure blocks domain identity'); return {status:response};
    ''')
    sql('browser-repair-profile', 'DROP TRIGGER browser_fail ON domain."User"; DROP FUNCTION domain.browser_fail();')
    code('profile-same-cookie-recovery', '''
      const result = await page.evaluate(async () => {
        const auth = await fetch('/api/auth/get-session').then(r=>r.json());
        const response = await fetch('/api/session'); return {status:response.status, authId:auth.user.id, profile:await response.json()};
      });
      check(result.status === 200 && result.authId === result.profile.userId, 'trusted same-cookie profile recovery'); return result;
    ''')
    cli('open-b', 'open', BASE + '/auth/signup', session='b')
    cli('second-screen', 'snapshot', session='b')
    code('duplicate-signup', '''
      await fill('Username', 'screenfixture'); await fill('Email', 'screenfixture@example.test');
      await fill('Password', password); await fill('Confirm password', password);
      await page.getByRole('button', {name:'Create your account', exact:true}).click();
      await page.getByRole('alert').waitFor(); return {duplicateRejected:await page.getByRole('alert').innerText()};
    ''', session='b')
    code('email-login-session-cookie', '''
      await login('screenfixture@example.test', password, false); await visible('Signed in as');
      const cookie = (await page.context().cookies()).find(c=>c.name.includes('session_token'));
      check(cookie.expires === -1 && cookie.httpOnly, 'nonpersistent cookie');
      await page.reload(); await visible('Signed in as');
      await page.getByRole('button', {name:'Sign out', exact:true}).click();
      await page.getByRole('heading', {name:'Sign in', exact:true}).waitFor();
      check(!(await page.context().cookies()).some(c=>c.name.includes('session_token')), 'logout removes cookie');
      check(await page.evaluate(()=>fetch('/api/session').then(r=>r.status)) === 401, 'logout rejected by DB boundary');
      return {emailLogin:true, cookie, reload:true, logout:true};
    ''', session='b')
    code('username-login-remember', '''
      await login('screenfixture'); await visible('Signed in as');
      const cookie = (await page.context().cookies()).find(c=>c.name.includes('session_token'));
      check(cookie.expires > Date.now()/1000, 'remember-me persistent'); return {usernameLogin:true,cookie};
    ''', session='b')
    assert sql('two-browser-sessions', f"SELECT count(*) FROM auth.session WHERE user_id='{check_id}'") == '2'
    code('unknown-email-neutral-response', '''
      await page.goto(base + '/auth/forgot-password'); await fill('Email', 'absent@example.test');
      await page.getByRole('button', {name:'Send reset link'}).click();
      await visible('If an account exists for that email, a password reset link is on its way.'); return true;
    ''')
    assert not list(OUT.glob('mail-*.eml'))
    code('reset-email-expired-request', '''
      await page.goto(base + '/auth/forgot-password'); await fill('Email', 'screenfixture@example.test');
      await page.getByRole('button', {name:'Send reset link'}).click(); await page.getByRole('status').waitFor();
      return {capturedRequest:true, message:await page.getByRole('status').innerText()};
    ''')
    link1 = reset_link(1)
    sql('expire-reset', "UPDATE auth.verification SET expires_at=now()-interval '1 day' WHERE identifier LIKE 'reset-password:%'")
    code('expired-link', f'''
      await page.goto({json.dumps(link1)}); await visible('This reset link is invalid or expired. Request a new link below.');
      return {{expiredLinkRejected:true}};
    ''')
    token1 = link1.split('/reset-password/')[1].split('?')[0]
    code('expired-token-submission', f'''
      await page.goto(base + '/auth/reset-password?token={token1}');
      await fill('Password', changed); await fill('Confirm password', changed);
      await page.getByRole('button', {{name:'Reset password',exact:true}}).click(); await page.getByRole('alert').waitFor();
      return {{expiredSubmissionRejected:await page.getByRole('alert').innerText()}};
    ''')
    code('reset-email-valid-request', '''
      await page.goto(base + '/auth/forgot-password'); await fill('Email', 'screenfixture@example.test');
      await page.getByRole('button', {name:'Send reset link'}).click(); await page.getByRole('status').waitFor(); return true;
    ''')
    link2 = reset_link(2)
    code('reset-screen-success', f'''
      await page.goto({json.dumps(link2)}); await fill('Password', changed); await fill('Confirm password', password);
      await page.getByRole('button', {{name:'Reset password',exact:true}}).click(); await visible('Passwords do not match.');
      await fill('Confirm password', changed); await page.getByRole('button', {{name:'Reset password',exact:true}}).click();
      await visible('Your password has been reset. Sign in with your new password.'); return {{confirmation:true,reset:true}};
    ''')
    assert sql('all-sessions-revoked', f"SELECT count(*) FROM auth.session WHERE user_id='{check_id}'") == '0'
    for session in ['a', 'b']:
        code('revoked-browser-' + session, '''
          await page.goto(base + '/auth/session'); await visible('You’re signed out.');
          check(await page.evaluate(()=>fetch('/api/session').then(r=>r.status)) === 401, 'prior cookie rejected');
          return {renderedSignedOut:true, oldCookieRejected:true};
        ''', session=session)
    code('reused-link', f'''
      await page.goto({json.dumps(link2)}); await visible('This reset link is invalid or expired. Request a new link below.'); return true;
    ''')
    token2 = link2.split('/reset-password/')[1].split('?')[0]
    code('reused-token-submission', f'''
      await page.goto(base + '/auth/reset-password?token={token2}'); await fill('Password', changed); await fill('Confirm password', changed);
      await page.getByRole('button', {{name:'Reset password',exact:true}}).click(); await page.getByRole('alert').waitFor();
      return {{reusedSubmissionRejected:await page.getByRole('alert').innerText()}};
    ''')
    code('old-password-rejected-new-password-login', '''
      await login('screenfixture'); await page.getByRole('alert').waitFor();
      const rejected = await page.getByRole('alert').innerText();
      await login('screenfixture', changed); await visible('Signed in as');
      return {oldPasswordRejected:rejected, newPasswordLogin:true};
    ''')
    code('local-return-validation', '''
      await page.getByRole('button',{name:'Sign out',exact:true}).click();
      await page.goto(base + '/auth/login?returnTo=https%3A%2F%2Fother.example.test');
      await fill('Username or email','screenfixture'); await fill('Password',changed);
      await page.getByRole('button',{name:'Sign in',exact:true}).click(); await visible('Signed in as');
      check(new URL(page.url()).origin === base && new URL(page.url()).pathname === '/auth/session', 'unsafe return stays local');
      await page.getByRole('button',{name:'Sign out',exact:true}).click();
      await page.goto(base + '/auth/login?returnTo=%2Fmethods');
      await fill('Username or email','screenfixture'); await fill('Password',changed);
      await page.getByRole('button',{name:'Sign in',exact:true}).click(); await page.waitForURL(url => url.origin === base && url.pathname === '/methods');
      return {unsafeRejected:true, localReturn:true};
    ''')
    cli('mobile-size', 'resize', '390', '844')
    code('mobile-login', '''await page.goto(base + '/auth/login'); const overflow = await page.evaluate(()=>document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth); check(!overflow, 'auth card fits mobile viewport'); return {horizontalOverflow:overflow};''')
    cli('mobile-login-screenshot', 'screenshot', '--filename', str(ARTIFACTS / 'mobile-login.png'))
    for session in ['a', 'b']:
        cli('console-' + session, 'console', session=session)
        cli('network-' + session, 'requests', session=session)
    print(f'PASS: rendered auth flows; {OUT / "browser-assertions.json"}')
finally:
    for session in ['a', 'b']:
        cli('close-' + session, 'close', session=session)
