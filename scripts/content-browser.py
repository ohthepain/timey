"""Method/module write proof through actual browser modules/server functions and disposable SQL."""
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
CLI = str(Path.home() / '.codex/skills/playwright/scripts/playwright_cli.sh')
COMMANDS = []
CHECKS = {}


def command(label, args, cwd=ROOT):
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log = ARTIFACTS / (label + '.log')
    log.write_text(result.stdout)
    COMMANDS.append({'command': args, 'exit': result.returncode, 'log': str(log)})
    (OUT / 'content-commands.json').write_text(json.dumps(COMMANDS, indent=2))
    if result.returncode or '### Error' in result.stdout:
        raise RuntimeError(f'{label} failed: {log}')
    return result.stdout


def cli(label, *args, session='a'):
    return command(label, [CLI, '--session', 'content-660150-' + session, *args], ARTIFACTS)


def code(label, body, session='a'):
    source = '''async (page) => {
      const base = BASE;
      const check = (condition, label) => { if (!condition) throw new Error(label); };
      const network = [], consoleMessages = [], pageErrors = [];
      const response = r => network.push({method:r.request().method(),url:r.url(),status:r.status(),cacheControl:r.headers()['cache-control']});
      const log = m => consoleMessages.push({type:m.type(),text:m.text()});
      const error = e => pageErrors.push(e.message);
      page.on('response',response); page.on('console',log); page.on('pageerror',error);
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate(async () => {
        await import('/_build/scripts/content-browser-client.mjs');
      });
      const value = await (async () => { BODY })();
      page.off('response',response); page.off('console',log); page.off('pageerror',error);
      return {value,network,consoleMessages,pageErrors};
    }'''.replace('BASE', json.dumps(BASE)).replace('BODY', body)
    file = ARTIFACTS / (label + '.js')
    file.write_text(source)
    output = cli(label, 'run-code', '--filename', str(file), session=session)
    match = re.search(r'### Result\n(.*?)\n###', output, re.S)
    assert match, output
    result = json.loads(match.group(1))
    unexpected = [error for error in result['pageErrors'] if error != 'MIDI output channel is undefined']
    hydration = [entry for entry in result['consoleMessages'] if entry['type'] == 'error' and 'hydrated' in entry['text']]
    if unexpected or hydration:
        raise RuntimeError(f'{label}: unexpected browser errors: {unexpected or hydration}')
    CHECKS[label] = result
    (OUT / 'content-assertions.json').write_text(json.dumps(CHECKS, indent=2))
    return result['value']


def sql(label, statement):
    return command(label, ['psql', TARGET['database'], '-v', 'ON_ERROR_STOP=1', '-Atc', statement]).strip()


def evaluate(label, body, session='a'):
    return code(label, 'return page.evaluate(async()=>{'+body+'});', session)


def rejected(label, calls, status, session='a'):
    result = evaluate(label, '''
      const results=[];
      for(const [name,data] of CALLS) {
        if(typeof window.content[name]!=='function')throw new Error('missing function '+name);
        try { await window.content[name]({data}); throw new Error('unexpected acceptance '+name); }
        catch(e) { if(e instanceof TypeError || e.message?.startsWith('unexpected acceptance'))throw e; results.push({name,error:String(e)}); }
      }
      return results;
    '''.replace('CALLS', json.dumps(calls)), session)
    requests = [r for r in CHECKS[label]['network'] if '/_server/' in r['url']]
    assert len(requests) == len(calls) and all(r['status'] == status for r in requests), requests
    return result


def api(label, method, data, status, session='a'):
    result = evaluate(label, '''
      const r=await fetch('/api/modules',{method:METHOD,headers:{'Content-Type':'application/json'},body:JSON.stringify(DATA)});
      return {status:r.status,body:await r.text()};
    '''.replace('METHOD',json.dumps(method)).replace('DATA',json.dumps(data)),session)
    assert result['status'] == status, result
    return result


def signup(session):
    return evaluate('signup-'+session, '''
      const name=NAME;
      const r=await fetch('/api/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,name,email:name+'@example.test',password:'Content-fixture-password-123!'})});
      if(!r.ok)throw new Error('signup failed'); return (await r.json()).user.id;
    '''.replace('NAME',json.dumps('content'+session)), session)


def sf(label, name, data, session='a'):
    return evaluate(label, 'return window.content[NAME]({data:DATA});'.replace('NAME',json.dumps(name)).replace('DATA',json.dumps(data)),session)


def state(label):
    return [sql(label+'-'+table.lower(), f'SELECT row_to_json(m)::text FROM domain."{table}" m ORDER BY id;')
            for table in ['Method', 'Module']]


try:
    for session in ['a','b']:
        cli('open-'+session,'open', BASE+'/methods',session=session)
        cli('initial-'+session,'snapshot',session=session)
    writes=[['createMethodServerFn',{'title':'Denied'}],['updateMethodServerFn',{'id':'selected','title':'Denied'}],
            ['createModuleServerFn',{'title':'Denied','methodId':'parent'}],['updateModuleServerFn',{'id':'selected','data':{'title':'Denied'}}]]
    def denied_matrix(label, status, session='a'):
        rejected(label,writes,status,session)
        api(label+'-post','POST',{'title':'Denied','methodId':'parent'},status,session)
        api(label+'-put','PUT',{'id':'selected','title':'Denied'},status,session)
    denied_matrix('missing-session',401)
    a=signup('a'); b=signup('b')
    ma=sf('create-method-a','createMethodServerFn',{'title':'Owner A method','description':'original','index':2})
    mb=sf('create-method-b','createMethodServerFn',{'title':'Owner B method'},'b')
    dest=sf('create-owned-destination','createMethodServerFn',{'title':'Owned destination'})
    mod=sf('create-module-a','createModuleServerFn',{'title':'Owner A module','methodId':ma['id'],'index':3})
    sf('owner-method-edit','updateMethodServerFn',{'id':ma['id'],'title':'Owner A edited'})
    sf('owner-module-edit','updateModuleServerFn',{'id':mod['id'],'data':{'title':'Module edited','description':'retained','index':4}})
    sf('owner-module-move','updateModuleServerFn',{'id':mod['id'],'data':{'methodId':dest['id']}})
    created=api('api-create','POST',{'title':'API module','methodId':ma['id']},201)
    api_module=json.loads(created['body'])
    api('api-owner-edit','PUT',{'id':api_module['id'],'title':'API edited','methodId':dest['id']},200)
    assert sql('trusted-method-authors',f'SELECT count(*) FROM domain."Method" WHERE "authorId"=\'{a}\';') == '2'
    assert sql('trusted-module-author',f'SELECT "authorId"||\':\'||"methodId"||\':\'||description FROM domain."Module" WHERE id=\'{mod["id"]}\';') == f"{a}:{dest['id']}:retained"
    before=state('before-denied')
    rejected('non-owner', [['updateMethodServerFn',{'id':ma['id'],'title':'stolen'}],['updateModuleServerFn',{'id':mod['id'],'data':{'title':'stolen'}}]],403,'b')
    rejected('destination-owner', [['createModuleServerFn',{'title':'Intruder','methodId':mb['id']}],['updateModuleServerFn',{'id':mod['id'],'data':{'methodId':mb['id']}}]],403)
    for method,data in [('POST',{'title':'Intruder','methodId':ma['id']}),('PUT',{'id':mod['id'],'title':'stolen'}),('PUT',{'id':mod['id'],'methodId':mb['id']})]:
        api('api-denied-'+method+'-'+str(len(CHECKS)),method,data,403,'b' if 'title' in data else 'a')
    attempts=[]
    for field, forged in {'authorId':b,'userId':b,'role':'admin','enableAdmin':True,'token':'forged'}.items():
        attempts.extend([[name,{**data,field:forged}] for name,data in writes[:3]])
        attempts.extend([
            ['updateModuleServerFn',{'id':mod['id'],'data':{'title':'forged',field:forged}}],
            ['updateModuleServerFn',{'id':mod['id'],'data':{},field:forged}],
        ])
    rejected('forged-fields',attempts,500)
    evaluate('api-forged-fields', '''
      const results=[];
      for(const field of ['authorId','userId','role','enableAdmin','token']) {
        for(const method of ['POST','PUT']) {
          const data=method==='POST'?{title:'forged',methodId:METHOD}:{id:MODULE,title:'forged'};
          data[field]=field==='enableAdmin'?true:'forged';
          const r=await fetch('/api/modules',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
          if(r.status!==400)throw new Error('forged field accepted '+field+' '+method);
          results.push({field,method,status:r.status,body:await r.text()});
        }
      }
      return results;
    '''.replace('METHOD',json.dumps(ma['id'])).replace('MODULE',json.dumps(mod['id'])))
    assert state('after-denied') == before, 'rejected writes changed rows'
    evaluate('forged-headers-ignored', '''
      const m=await window.content.createMethodServerFn({data:{title:'Header fixture'},headers:{Authorization:'Bearer forged','x-user-id':OTHER,'x-role':'admin'}});
      if(m.authorId!==OWNER)throw new Error('headers selected identity');return m;
    '''.replace('OTHER',json.dumps(b)).replace('OWNER',json.dumps(a)))
    # A locked parent changes owner before the waiting request can authorize.
    locklog=(ARTIFACTS/'concurrent-parent.log').open('w')
    lock=subprocess.Popen(['psql',TARGET['database'],'-v','ON_ERROR_STOP=1','-c',f'''BEGIN; UPDATE domain."Method" SET "authorId"='{b}' WHERE id='{dest['id']}'; SELECT pg_sleep(4); COMMIT;'''],stdout=locklog,stderr=subprocess.STDOUT)
    import time
    time.sleep(0.5)
    rejected('concurrent-parent-change',[['createModuleServerFn',{'title':'Concurrent denied','methodId':dest['id']}],['updateModuleServerFn',{'id':mod['id'],'data':{'methodId':dest['id']}}]],403)
    assert lock.wait()==0
    locklog.close()
    sql('restore-parent',f'''UPDATE domain."Method" SET "authorId"='{a}' WHERE id='{dest['id']}';''')
    locklog=(ARTIFACTS/'concurrent-module.log').open('w')
    lock=subprocess.Popen(['psql',TARGET['database'],'-v','ON_ERROR_STOP=1','-c',f'''BEGIN; UPDATE domain."Module" SET "authorId"='{b}' WHERE id='{mod['id']}'; SELECT pg_sleep(4); COMMIT;'''],stdout=locklog,stderr=subprocess.STDOUT)
    time.sleep(0.5)
    rejected('concurrent-module-change',[['updateModuleServerFn',{'id':mod['id'],'data':{'methodId':ma['id']}}]],403)
    assert lock.wait()==0
    locklog.close()
    sql('restore-module',f'''UPDATE domain."Module" SET "authorId"='{a}' WHERE id='{mod['id']}';''')
    # Existing rendered controls, including state reset without reloading on account switch.
    code('rendered-create-edit', '''
      await page.goto(base+'/methods');
      const name=page.getByPlaceholder('New method name');
      await page.getByRole('button',{name:'Create',exact:true}).waitFor();
      await page.waitForFunction(()=>!document.querySelector('.btn-create').disabled);
      await name.fill('Rendered method');
      await page.getByRole('button',{name:'Create',exact:true}).click();
      const row=page.locator('li').filter({has:page.getByRole('link',{name:'Rendered method',exact:true})});
      await row.getByRole('button',{name:'Edit',exact:true}).click();
      await page.locator('.method-item input').fill('Rendered edited');
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.getByRole('link',{name:'Rendered edited',exact:true}).waitFor();
      return true;
    ''')
    rendered=sql('rendered-method-id', '''SELECT id FROM domain."Method" WHERE title='Rendered edited';''')
    code('rendered-permission-error','''
      const row=page.locator('li').filter({has:page.getByRole('link',{name:'Rendered edited',exact:true})});
      await row.getByRole('button',{name:'Edit',exact:true}).click();return true;
    ''')
    sql('change-rendered-owner',f'''UPDATE domain."Method" SET "authorId"='{b}' WHERE id='{rendered}';''')
    code('rendered-error-message', '''
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'Only the original author'}).waitFor();return true;
    ''')
    sql('restore-rendered-owner',f'''UPDATE domain."Method" SET "authorId"='{a}' WHERE id='{rendered}';''')
    code('switch-clears-method-draft', '''
      await page.evaluate(async()=>{const c=(await import('/_build/src/server/auth-runtime/client.ts')).authClient;await c.signOut();await c.signIn.username({username:'contentb',password:'Content-fixture-password-123!'});});
      await page.waitForFunction(()=>!document.querySelector('.btn-update'));
      const row=page.locator('li').filter({has:page.getByRole('link',{name:'Rendered edited',exact:true})});
      check(await row.getByRole('button',{name:'Edit',exact:true}).isDisabled(),'new account cannot edit old author');
      return true;
    ''')
    code('switch-back', '''
      await page.evaluate(async()=>{const c=(await import('/_build/src/server/auth-runtime/client.ts')).authClient;await c.signOut();await c.signIn.username({username:'contenta',password:'Content-fixture-password-123!'});});
      return true;
    ''')
    code('rendered-add-module', '''
      await page.goto(base+'/method/ID');
      await page.getByRole('button',{name:'Add Module',exact:true}).waitFor();
      await page.locator('.add-module input[type=text]').fill('Rendered module');
      await page.locator('.add-module input[type=number]').fill('9');
      await page.getByRole('button',{name:'Add Module',exact:true}).click();
      await page.getByRole('link',{name:'Rendered module',exact:true}).waitFor();
      return true;
    '''.replace('ID',rendered))
    cli('created-module','screenshot','--filename',str(ARTIFACTS/'created-module.png'))
    code('module-account-switch', '''
      await page.locator('.add-module input[type=text]').fill('Must be cleared');
      await page.evaluate(async()=>{const c=(await import('/_build/src/server/auth-runtime/client.ts')).authClient;await c.signOut();await c.signIn.username({username:'contentb',password:'Content-fixture-password-123!'});});
      await page.getByText('Only the method author can add modules.',{exact:true}).waitFor();
      check(await page.getByRole('button',{name:'Add Module',exact:true}).count()===0,'non-owner creation absent');return true;
    ''')
    code('anonymous-signin-path', '''
      await page.evaluate(async()=>{await (await import('/_build/src/server/auth-runtime/client.ts')).authClient.signOut();});
      await page.getByRole('link',{name:'Sign in to add modules',exact:true}).click();
      await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();return true;
    ''')
    # Refresh A's cookie after the rendered switching checks.
    evaluate('login-for-expiry', '''const r=await fetch('/api/auth/sign-in/username',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'contenta',password:'Content-fixture-password-123!'})});if(!r.ok)throw new Error('login');return true;''')
    sql('expire-a',f"UPDATE auth.session SET expires_at=now()-interval '1 day' WHERE user_id='{a}'")
    denied_matrix('expired-session',401)
    sql('revoke-b',f"DELETE FROM auth.session WHERE user_id='{b}'")
    denied_matrix('revoked-session',401,'b')
    # Reuse A's browser with a new identity whose profile is not yet provisioned.
    evaluate('clear-for-retry', '''await fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return true;''')
    retry=evaluate('retry-signup', '''const name='contentretry';const r=await fetch('/api/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,name,email:name+'@example.test',password:'Content-fixture-password-123!'})});if(!r.ok)throw new Error('signup');return (await r.json()).user.id;''')
    sql('fail-profile', '''CREATE FUNCTION domain.content_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable provisioning failure'; END $$; CREATE TRIGGER content_fail BEFORE INSERT ON domain."User" FOR EACH ROW EXECUTE FUNCTION domain.content_fail();''')
    before=state('before-profile-failure')
    denied_matrix('profile-failure',503)
    assert state('after-profile-failure')==before
    assert sql('no-profile-after-failure',f'''SELECT count(*) FROM domain."User" WHERE id='{retry}';''')=='0'
    sql('repair-profile','DROP TRIGGER content_fail ON domain."User"; DROP FUNCTION domain.content_fail();')
    recovered=sf('recover-profile-create','createMethodServerFn',{'title':'Recovered profile'})
    assert recovered['authorId']==retry
    assert sql('recovered-stable-id',f'''SELECT id FROM domain."User" WHERE id='{retry}';''')==retry
    code('forged-cookie', '''await page.context().clearCookies();await page.context().addCookies([{name:'better-auth.session_token',value:'forged',url:base}]);return true;''')
    denied_matrix('forged-session',401)
    public=evaluate('public-reads', '''
      const c=window.content;
      const methods=await c.getAllMethodsServerFn();const modules=await c.getAllModulesServerFn();
      const method=await c.getMethodByIdServerFn({data:{id:METHOD}});const module=await c.getModuleByIdServerFn({data:{id:MODULE}});
      const list=await fetch('/api/modules');const item=await fetch('/api/modules/'+MODULE);
      if(!methods.length || !modules.length || !method || !module || list.status!==200 || item.status!==200)throw new Error('public read failure');
      return {methods,modules,method,module,api:[list.status,item.status]};
    '''.replace('METHOD',json.dumps(ma['id'])).replace('MODULE',json.dumps(mod['id'])))
    state('final-domain-assertions')
    for session in ['a','b']:
        cli('console-'+session,'console',session=session)
        cli('requests-'+session,'requests',session=session)
    print(f'PASS method/module writes: {OUT / "content-assertions.json"}',flush=True)
finally:
    for session in ['a','b']:
        cli('close-'+session,'close',session=session)
