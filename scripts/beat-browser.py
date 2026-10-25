"""Beat creation/copy proof through actual browser modules/server functions and disposable SQL."""
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
    (OUT / 'beat-commands.json').write_text(json.dumps(COMMANDS, indent=2))
    if result.returncode or '### Error' in result.stdout:
        raise RuntimeError(f'{label} failed: {log}')
    return result.stdout


def cli(label, *args, session='a'):
    return command(label, [CLI, '--session', 'beats-f6cfd8-' + session, *args], ARTIFACTS)


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
        await import('/_build/scripts/beat-browser-client.mjs');
      });
      page.setDefaultTimeout(15000);
      let value, failure;
      try { value = await (async () => { BODY })(); } catch(e) { failure=String(e); }
      page.off('response',response); page.off('console',log); page.off('pageerror',error);
      return {value,network,consoleMessages,pageErrors,failure};
    }'''.replace('BASE', json.dumps(BASE)).replace('BODY', body)
    file = ARTIFACTS / (label + '.js')
    file.write_text(source)
    output = cli(label, 'run-code', '--filename', str(file), session=session)
    match = re.search(r'### Result\n(.*?)\n###', output, re.S)
    assert match, output
    result = json.loads(match.group(1))
    unexpected = [error for error in result['pageErrors'] if error != 'MIDI output channel is undefined']
    hydration = [entry for entry in result['consoleMessages'] if entry['type'] == 'error' and 'hydrated' in entry['text']]
    (OUT / 'beat-assertions.json').write_text(json.dumps({**CHECKS,label:result}, indent=2))
    if result.get('failure'): raise RuntimeError(f"{label}: {result['failure']}")
    if unexpected or hydration:
        raise RuntimeError(f'{label}: unexpected browser errors: {unexpected or hydration}')
    CHECKS[label] = result
    (OUT / 'beat-assertions.json').write_text(json.dumps(CHECKS, indent=2))
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
      const r=await fetch('/api/beats',{method:METHOD,headers:{'Content-Type':'application/json'},body:JSON.stringify(DATA)});
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
            for table in ['Method', 'Module', 'Beat', 'BeatNote', 'BeatProgress', 'Performance']]


try:
    for session in ['a','b']:
        cli('open-'+session,'open', BASE+'/methods',session=session)
        cli('initial-'+session,'snapshot',session=session)
    note={'index':0,'duration':8,'noteString':'kick','barNum':0,'beatNum':0,'divisionNum':0,'subDivisionNum':0,'numSubDivisions':1,'velocity':100,'microtiming':2}
    create={'name':'Source 7','description':'Musical description','moduleId':'absent','index':2,'beatNotes':[{**note,'index':n,'beatNum':n//2,'divisionNum':n%2} for n in range(8)]}
    api_input={'name':'API beat','moduleId':'absent','index':1,'beatString':'\n'.join(f'note,{n},8,[kick],0,{n//2},{n%2},0,1' for n in range(8))}
    copies={'id':'absent','moduleId':'absent'}
    def denied(label,status,session='a'):
        rejected(label,[['createBeatServerFn',create],['copyBeatServerFn',copies]],status,session)
        api(label+'-api','PUT',api_input,status,session)
    denied('missing-session',401)
    a=signup('a'); b=signup('b')
    # B initially has no owned destination; use the existing method/module controls to recover.
    ma=sf('method-a','createMethodServerFn',{'title':'Beat fixture A'})
    mod=sf('module-a','createModuleServerFn',{'title':'Module A','methodId':ma['id']})
    create['moduleId']=mod['id'];api_input['moduleId']=mod['id'];copies['moduleId']=mod['id']
    source=sf('owner-create','createBeatServerFn',create)
    copies['id']=source['id']
    assert source['authorId']==a and len(source['beatNotes'])==8
    api('owner-api','PUT',api_input,200)
    code('no-destination', '''
      await page.goto(base+'/module/MODULE');
      await page.getByRole('button',{name:'Copy',exact:true}).first().click();
      await page.getByText('You need a module of your own.',{exact:false}).waitFor();
      await page.getByRole('link',{name:'Create a method, then add a module',exact:true}).click();
      await page.getByRole('link',{name:'Practice account',exact:true}).waitFor();
      await page.waitForFunction(()=>!document.querySelector('.btn-create').disabled);
      const input=page.getByPlaceholder('New method name');await input.fill('Rendered B method');
      const button=page.getByRole('button',{name:'Create',exact:true});await button.click();
      await page.getByRole('link',{name:'Rendered B method',exact:true}).click();
      await page.locator('.add-module input[type=text]').fill('Rendered B module');
      await page.getByRole('button',{name:'Add Module',exact:true}).click();
      await page.getByRole('link',{name:'Rendered B module',exact:true}).waitFor();return true;
    '''.replace('MODULE',mod['id']), 'b')
    mb=sql('b-module-id',f'''SELECT id FROM domain."Module" WHERE "authorId"='{b}';''')
    # Both source-associated and unrelated history for both users must survive.
    unrelated=sf('unrelated-beat','createBeatServerFn',{**create,'name':'Unrelated beat'})
    for owner in [a,b]:
        for target in [source['id'],unrelated['id']]:
            key=owner+'-'+target
            sql('history-'+key,f'''INSERT INTO domain."BeatProgress" (id,"userId","beatId","bestTempo","updatedAt") VALUES ('progress-{key}','{owner}','{target}',123,now());
              INSERT INTO domain."Performance" (id,"userId","beatId",index,"modifiedAt") VALUES ('performance-{key}','{owner}','{target}',0,now());
              INSERT INTO domain."BeatNote" (id,index,duration,"noteString","barNum","beatNum","divisionNum","subDivisionNum","numSubDivisions",velocity,"performanceId") VALUES ('played-{key}',0,8,'kick',0,0,0,0,1,80,'performance-{key}');''')
    preserved=state('before-copy')
    copied=sf('public-source-owned-copy','copyBeatServerFn',{'id':source['id'],'moduleId':mb},'b')
    assert copied['authorId']==b and copied['moduleId']==mb and copied['name']=='Source 8'
    assert copied['description']==create['description']
    assert copied['id']!=source['id'] and copied['beatNotes'][0]['id']!=source['beatNotes'][0]['id']
    assert [{key:n[key] for key in note} for n in sorted(copied['beatNotes'],key=lambda n:n['index'])]==create['beatNotes']
    after=state('after-copy')
    assert preserved[0:2]==after[0:2] and preserved[4:]==after[4:]
    assert sql('source-preserved',f'''SELECT row_to_json(b)::text FROM domain."Beat" b WHERE id='{source['id']}';''') in preserved[2]
    assert set(sql('source-notes-preserved',f'''SELECT row_to_json(b)::text FROM domain."BeatNote" b WHERE "beatId"='{source['id']}' ORDER BY id;''').splitlines()).issubset(set(preserved[3].splitlines()))
    before=state('before-rejections')
    rejected('another-user-destination',[['createBeatServerFn',create],['copyBeatServerFn',copies]],403,'b')
    api('another-user-api','PUT',api_input,403,'b')
    rejected('missing-source',[['copyBeatServerFn',{'id':'absent','moduleId':mod['id']}]],404)
    attempts=[]
    for field,value in {'authorId':b,'userId':b,'role':'admin','token':'forged','enableAdmin':True,'id':'forged'}.items():
        if field!='id':attempts.append(['copyBeatServerFn',{**copies,field:value}])
        attempts.append(['createBeatServerFn',{**create,field:value}])
        if field!='id':api('forged-api-'+field,'PUT',{**api_input,field:value},400)
    attempts.extend([['createBeatServerFn',{**create,'beatNotes':[{**note,'id':'forged'}]}],['createBeatServerFn',{**create,'beatNotes':[{**note,'performanceId':'forged'}]}]])
    rejected('forged-inputs',attempts,500)
    assert state('after-rejections')==before
    # Atomic nested-write failure after the parent insertion.
    sql('fail-note', '''CREATE FUNCTION domain.fail_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable note failure'; END $$; CREATE TRIGGER fail_note BEFORE INSERT ON domain."BeatNote" FOR EACH ROW EXECUTE FUNCTION domain.fail_note();''')
    rejected('atomic-note-failure',[['createBeatServerFn',create],['copyBeatServerFn',copies]],500)
    api('atomic-api-failure','PUT',api_input,500)
    assert state('after-note-failure')==before
    sql('repair-note','DROP TRIGGER fail_note ON domain."BeatNote"; DROP FUNCTION domain.fail_note();')
    # A concurrent transaction changes the destination before waiting operations authorize.
    import time
    for label,operation in [('create',['createBeatServerFn',create]),('copy',['copyBeatServerFn',copies]),('api',None)]:
        locklog=(ARTIFACTS/('concurrent-'+label+'.log')).open('w')
        lock=subprocess.Popen(['psql',TARGET['database'],'-v','ON_ERROR_STOP=1','-c',f'''BEGIN; UPDATE domain."Module" SET "authorId"='{b}' WHERE id='{mod['id']}'; SELECT pg_sleep(4); COMMIT;'''],stdout=locklog,stderr=subprocess.STDOUT)
        time.sleep(0.5)
        if operation:rejected('concurrent-'+label,[operation],403)
        else:api('concurrent-api','PUT',api_input,403)
        exit_code=lock.wait();locklog.close()
        COMMANDS.append({'command':lock.args,'exit':exit_code,'log':str(ARTIFACTS/('concurrent-'+label+'.log'))})
        (OUT/'beat-commands.json').write_text(json.dumps(COMMANDS,indent=2))
        assert exit_code==0
        sql('restore-'+label,f'''UPDATE domain."Module" SET "authorId"='{a}' WHERE id='{mod['id']}';''')
    assert state('after-concurrency')==before
    # Rendered owner creation and destination selection, independent of persisted Admin flag.
    code('rendered-owner-create', '''
      await page.goto(base+'/module/MODULE');
      const section=page.getByRole('region',{name:'New beat'});await section.waitFor();
      await section.getByPlaceholder('Enter beat name').fill('Rendered beat');
      await section.getByRole('button',{name:'Add Bar',exact:true}).click();
      await section.getByRole('button',{name:'Save',exact:true}).click();
      await page.getByText('Rendered beat',{exact:true}).waitFor();return true;
    '''.replace('MODULE',mod['id']))
    code('rendered-copy', '''
      await page.goto(base+'/module/MODULE');
      await page.getByText('Source 7',{exact:true}).locator('..').getByRole('button',{name:'Copy',exact:true}).click();
      await page.getByLabel('Destination module').selectOption(DESTINATION);
      await page.getByRole('button',{name:'Copy beat',exact:true}).click();
      await page.getByRole('link',{name:'View copied beat',exact:true}).click();
      await page.getByText('Source 8',{exact:true}).first().waitFor();return true;
    '''.replace('MODULE',mod['id']).replace('DESTINATION',json.dumps(mb)),'b')
    assert sql('rendered-copy-row',f'''SELECT count(*) FROM domain."Beat" WHERE name='Source 8' AND "moduleId"='{mb}' AND "authorId"='{b}';''')=='2'
    cli('rendered-copy','screenshot','--filename',str(ARTIFACTS/'rendered-copy.png'),session='b')
    code('switch-clears-draft', '''
      await page.goto(base+'/module/MODULE');
      await page.getByRole('region',{name:'New beat'}).getByPlaceholder('Enter beat name').fill('Stale draft');
      await page.getByRole('button',{name:'Copy',exact:true}).first().click();
      await page.getByLabel('Destination module').selectOption(DESTINATION);
      await page.evaluate(async()=>{const c=(await import('/_build/src/server/auth-runtime/client.ts')).authClient;await c.signOut();await c.signIn.username({username:'contentb',password:'Content-fixture-password-123!'});});
      await page.getByText('Only the module author can create beats here.',{exact:true}).waitFor();
      check(await page.getByLabel('Destination module').count()===0,'old destination cleared');
      await page.getByRole('button',{name:'Copy',exact:true}).first().click();
      const select=page.getByLabel('Destination module');await select.waitFor();
      check(await select.inputValue()==='','new destination empty');
      check(await select.locator('option[value="'+DESTINATION+'"]').count()===0,'old destination unavailable');return true;
    '''.replace('MODULE',mod['id']).replace('DESTINATION',json.dumps(mod['id'])))
    code('switch-back-clears-draft', '''
      await page.evaluate(async()=>{const c=(await import('/_build/src/server/auth-runtime/client.ts')).authClient;await c.signOut();await c.signIn.username({username:'contenta',password:'Content-fixture-password-123!'});});
      const name=page.getByRole('region',{name:'New beat'}).getByPlaceholder('Enter beat name');await name.waitFor();
      check(await name.inputValue()==='New Beat','old draft removed');return true;
    ''')
    # Expiry/revocation fail through real requests, never JavaScript/import errors.
    sql('expire-a',f"UPDATE auth.session SET expires_at=now()-interval '1 day' WHERE user_id='{a}'")
    denied('expired-session',401)
    sql('revoke-b',f"DELETE FROM auth.session WHERE user_id='{b}'")
    denied('revoked-session',401,'b')
    evaluate('clear-for-retry', '''await fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return true;''')
    retry=evaluate('retry-signup', '''const name='beatretry';const r=await fetch('/api/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,name,email:name+'@example.test',password:'Content-fixture-password-123!'})});if(!r.ok)throw new Error('signup');return (await r.json()).user.id;''')
    sql('fail-profile', '''CREATE FUNCTION domain.beat_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable profile failure'; END $$; CREATE TRIGGER beat_fail BEFORE INSERT ON domain."User" FOR EACH ROW EXECUTE FUNCTION domain.beat_fail();''')
    before=state('before-profile-failure');denied('profile-failure',503)
    assert state('after-profile-failure')==before
    sql('repair-profile','DROP TRIGGER beat_fail ON domain."User"; DROP FUNCTION domain.beat_fail();')
    mr=sf('retry-method','createMethodServerFn',{'title':'Retry method'})
    modr=sf('retry-module','createModuleServerFn',{'title':'Retry module','methodId':mr['id']})
    recovered=sf('retry-create','createBeatServerFn',{**create,'moduleId':modr['id']})
    assert recovered['authorId']==retry
    recovered_copy=sf('retry-copy','copyBeatServerFn',{'id':source['id'],'moduleId':modr['id']})
    assert recovered_copy['authorId']==retry
    code('forged-cookie', '''await page.context().clearCookies();await page.context().addCookies([{name:'better-auth.session_token',value:'forged',url:base}]);return true;''')
    denied('forged-session',401)
    code('public-local-practice', '''
      await page.goto(base+'/module/MODULE');
      await page.getByText('Source 7',{exact:true}).waitFor();
      await page.getByRole('link',{name:'Sign in to create beats',exact:true}).waitFor();
      await page.getByRole('link',{name:'Sign in to copy',exact:true}).first().waitFor();
      await page.locator('svg').first().locator('..').click();
      await page.getByRole('button',{name:'Play',exact:true}).click();
      await page.getByRole('button',{name:'Stop',exact:true}).click();
      await page.getByRole('button',{name:'Record',exact:true}).click();
      await page.getByRole('button',{name:'Stop',exact:true}).click();
      check(await page.locator('.transport-controls').getByRole('button',{name:'Save',exact:true}).count()===0,'anonymous persistence hidden');
      await page.getByRole('link',{name:'Sign in to copy',exact:true}).first().click();
      await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();return true;
    '''.replace('MODULE',mod['id']))
    final=state('final-state')
    assert final[4:]==preserved[4:], 'private history changed'
    for table_index in [2,3]:
        assert set(preserved[table_index].splitlines()).issubset(set(final[table_index].splitlines())), 'source or unrelated content changed'
    assert sql('no-copy-history',f'''SELECT count(*) FROM domain."BeatProgress" WHERE "beatId"='{copied['id']}';''')=='0'
    for session in ['a','b']:
        cli('console-'+session,'console',session=session);cli('requests-'+session,'requests',session=session)
    print(f'PASS beat creation/copy: {OUT / "beat-assertions.json"}',flush=True)
finally:
    for session in ['a','b']:
        cli('close-'+session,'close',session=session)
