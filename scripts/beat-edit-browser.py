"""Ordinary-author existing-beat edit proof through actual browser modules/server functions and disposable SQL."""
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
    (OUT / 'beat-edit-commands.json').write_text(json.dumps(COMMANDS, indent=2))
    if result.returncode or '### Error' in result.stdout:
        raise RuntimeError(f'{label} failed: {log}')
    return result.stdout


def cli(label, *args, session='a'):
    return command(label, [CLI, '--session', 'beat-edit-3bced6-' + session, *args], ARTIFACTS)


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
    (OUT / 'beat-edit-assertions.json').write_text(json.dumps({**CHECKS,label:result}, indent=2))
    if result.get('failure'): raise RuntimeError(f"{label}: {result['failure']}")
    if unexpected or hydration:
        raise RuntimeError(f'{label}: unexpected browser errors: {unexpected or hydration}')
    CHECKS[label] = result
    (OUT / 'beat-edit-assertions.json').write_text(json.dumps(CHECKS, indent=2))
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
    # Background public route refreshes are retained, but are not mutation denials.
    requests = [r for r in CHECKS[label]['network']
                if any('--'+name+'_createServerFn' in r['url'] for name, _ in calls)]
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


def history(label):
    # All history, including the schema-permitted dual beat/performance relation.
    return [sql(label+'-'+table.lower(), f'SELECT row_to_json(m)::text FROM domain."{table}" m ORDER BY id;')
            for table in ['BeatProgress','Performance','ModuleProgress','MethodProgress']] + [
        sql(label+'-played', 'SELECT row_to_json(n)::text FROM domain."BeatNote" n WHERE "performanceId" IS NOT NULL ORDER BY id;')]


def concurrent(label, statement, operation):
    import time
    path=ARTIFACTS/(label+'-lock.log')
    with path.open('w') as output:
        args=['psql',TARGET['database'],'-v','ON_ERROR_STOP=1','-c',
              f"BEGIN; SET application_name='{label}'; {statement}; SELECT pg_sleep(5); COMMIT;"]
        process=subprocess.Popen(args,stdout=output,stderr=subprocess.STDOUT)
        for attempt in range(50):
            ready=sql(label+'-ready-'+str(attempt),f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{label}' AND wait_event='PgSleep';")
            if ready=='1':break
            time.sleep(0.1)
        else:raise RuntimeError('concurrent lock did not become ready')
        operation()
        exit_code=process.wait()
    COMMANDS.append({'command':args,'exit':exit_code,'log':str(path)})
    (OUT/'beat-edit-commands.json').write_text(json.dumps(COMMANDS,indent=2))
    assert exit_code==0


try:
    for session in ['a','b']:
        cli('open-'+session,'open',BASE+'/methods',session=session)
        cli('initial-'+session,'snapshot',session=session)
    note={'index':0,'duration':8,'noteString':'kick','barNum':0,'beatNum':0,'divisionNum':0,'subDivisionNum':0,'numSubDivisions':1,'velocity':100,'microtiming':2}
    notes=[{**note,'index':n,'beatNum':n//2,'divisionNum':n%2} for n in range(8)]
    edit={'id':'absent','name':'Edited beat','moduleId':'absent','index':4,'beatNotes':notes}
    api_input={'id':'absent','name':'API edited beat','moduleId':'absent','index':5,'beatString':'\n'.join(f'note,{n},8,[kick],0,{n//2},{n%2},0,1' for n in range(8))}
    def denied(label,status,session='a'):
        rejected(label,[['saveBeatServerFn',edit]],status,session)
        api(label+'-api','PUT',api_input,status,session)
    denied('missing-session',401)
    a=signup('a');b=signup('b')
    ma=sf('method-a','createMethodServerFn',{'title':'Editing A'})
    mod=sf('module-a','createModuleServerFn',{'title':'Source module','methodId':ma['id']})
    dest=sf('destination-a','createModuleServerFn',{'title':'Owned destination','methodId':ma['id']})
    mb=sf('method-b','createMethodServerFn',{'title':'Editing B'},'b')
    foreign=sf('module-b','createModuleServerFn',{'title':'Unowned destination','methodId':mb['id']},'b')
    source=sf('source','createBeatServerFn',{'name':'Source beat','moduleId':mod['id'],'index':1,'beatNotes':notes})
    other=sf('unrelated','createBeatServerFn',{'name':'Unrelated beat','moduleId':foreign['id'],'index':1,'beatNotes':notes},'b')
    edit.update(id=source['id'],moduleId=mod['id']);api_input.update(id=source['id'],moduleId=mod['id'])
    for owner in [a,b]:
        sql('parent-history-'+owner,f'''INSERT INTO domain."MethodProgress" (id,"userId","methodId","updatedAt","targetLevel") VALUES ('method-{owner}','{owner}','{ma['id']}',now(),140);
          INSERT INTO domain."ModuleProgress" (id,"userId","moduleId","updatedAt") VALUES ('module-{owner}','{owner}','{mod['id']}',now());''')
        for target in [source['id'],other['id']]:
            key=owner+'-'+target
            sql('history-'+key,f'''INSERT INTO domain."BeatProgress" (id,"userId","beatId","bestTempo","updatedAt") VALUES ('progress-{key}','{owner}','{target}',123,now());
              INSERT INTO domain."Performance" (id,"userId","beatId",index,"modifiedAt") VALUES ('performance-{key}','{owner}','{target}',0,now());
              INSERT INTO domain."BeatNote" (id,index,duration,"noteString","barNum","beatNum","divisionNum","subDivisionNum","numSubDivisions",velocity,"performanceId") VALUES ('played-{key}',0,8,'kick',0,0,0,0,1,80,'performance-{key}');''')
    # Also preserve performance-owned notes when both nullable relations are populated.
    sql('dual-note',f'''UPDATE domain."BeatNote" SET "beatId"='{source['id']}' WHERE id='played-{a}-{source['id']}';''')
    baseline_history=history('history-before')
    unrelated=sql('unrelated-before',f'''SELECT row_to_json(b)::text FROM domain."Beat" b WHERE id='{other['id']}';''')
    unrelated_notes=sql('unrelated-notes-before',f'''SELECT row_to_json(b)::text FROM domain."BeatNote" b WHERE "beatId"='{other['id']}' ORDER BY id;''')
    changed=sf('owner-edit','saveBeatServerFn',edit)
    assert changed['authorId']==a and changed['name']==edit['name'] and len(changed['beatNotes'])==8
    assert all(n['performanceId'] is None for n in changed['beatNotes'])
    api('owner-api-edit','PUT',api_input,200)
    moved=sf('owner-move','saveBeatServerFn',{**edit,'moduleId':dest['id']})
    assert moved['moduleId']==dest['id'] and moved['authorId']==a
    api('owner-api-move','PUT',api_input,200)
    assert history('history-after-edits')==baseline_history
    before=state('before-denials')
    denied('another-user',403,'b')
    rejected('unowned-move',[['saveBeatServerFn',{**edit,'moduleId':foreign['id']}]],403)
    api('unowned-api-move','PUT',{**api_input,'moduleId':foreign['id']},403)
    rejected('absent-beat',[['saveBeatServerFn',{**edit,'id':'absent'}]],404)
    api('absent-beat-api','PUT',{**api_input,'id':'absent'},404)
    attempts=[]
    for field,value in {'authorId':b,'userId':b,'role':'admin','token':'forged','enableAdmin':True}.items():
        attempts.append(['saveBeatServerFn',{**edit,field:value}])
        api('forged-api-'+field,'PUT',{**api_input,field:value},400)
    for field in ['id','authorId','performanceId','beatId']:
        attempts.append(['saveBeatServerFn',{**edit,'beatNotes':[{**note,field:'forged'}]}])
    attempts.extend([['saveBeatServerFn',{**edit,'index':1.5}],['saveBeatServerFn',{**edit,'beatNotes':[{'index':0}]}]])
    rejected('strict-inputs',attempts,500)
    assert state('after-denials')==before
    # Note replacement must roll back the beat update and deletion of old content notes.
    sql('fail-note', '''CREATE FUNCTION domain.fail_edit_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable edit note failure'; END $$; CREATE TRIGGER fail_edit_note BEFORE INSERT ON domain."BeatNote" FOR EACH ROW EXECUTE FUNCTION domain.fail_edit_note();''')
    rejected('rollback',[['saveBeatServerFn',edit]],500)
    api('rollback-api','PUT',api_input,500)
    assert state('after-rollback')==before and history('rollback-history')==baseline_history
    sql('repair-note','DROP TRIGGER fail_edit_note ON domain."BeatNote"; DROP FUNCTION domain.fail_edit_note();')
    for transport in ['sf','api']:
        concurrent('destination-'+transport,f'''UPDATE domain."Module" SET "authorId"='{b}' WHERE id='{dest['id']}';''',
          lambda: rejected('concurrent-destination-sf',[['saveBeatServerFn',{**edit,'moduleId':dest['id']}]],403) if transport=='sf' else api('concurrent-destination-api','PUT',{**api_input,'moduleId':dest['id']},403))
        sql('restore-destination-'+transport,f'''UPDATE domain."Module" SET "authorId"='{a}' WHERE id='{dest['id']}';''')
        concurrent('author-'+transport,f'''UPDATE domain."Beat" SET "authorId"='{b}' WHERE id='{source['id']}';''',
          lambda: denied('concurrent-author-'+transport,403))
        sql('restore-author-'+transport,f'''UPDATE domain."Beat" SET "authorId"='{a}' WHERE id='{source['id']}';''')
    # If another writer moved the beat while waiting, the old parent becomes a destination.
    sql('old-parent-not-owned',f'''UPDATE domain."Module" SET "authorId"='{b}' WHERE id='{mod['id']}';''')
    concurrent('current-parent-change',f'''UPDATE domain."Beat" SET "moduleId"='{dest['id']}' WHERE id='{source['id']}';''',lambda: denied('concurrent-parent',403))
    sql('restore-parent',f'''UPDATE domain."Module" SET "authorId"='{a}' WHERE id='{mod['id']}'; UPDATE domain."Beat" SET "moduleId"='{mod['id']}' WHERE id='{source['id']}';''')
    assert state('after-concurrency')==before
    code('rendered-owner-edit', '''
      await page.goto(base+'/module/MODULE');
      const edit=page.getByRole('button',{name:'Edit',exact:true});await edit.waitFor();await edit.click();
      await page.getByPlaceholder('Enter beat name').first().fill('Rendered edit');
      await page.locator('.btn-create').first().click();
      await page.getByText('Rendered edit',{exact:true}).waitFor();
      check(await page.getByTitle('Edit',{exact:true}).textContent()==='Edit','editor closed');return true;
    '''.replace('MODULE',mod['id']))
    assert sql('rendered-edit-row',f'''SELECT count(*) FROM domain."Beat" WHERE id='{source['id']}' AND name='Rendered edit' AND "authorId"='{a}';''')=='1'
    cli('owner-edit','screenshot','--filename',str(ARTIFACTS/'owner-edit.png'))
    code('rendered-non-owner', '''
      await page.goto(base+'/module/MODULE');await page.getByRole('link',{name:'Practice account',exact:true}).waitFor();
      check(await page.getByRole('button',{name:'Edit',exact:true}).count()===0,'other user has no editor');return true;
    '''.replace('MODULE',mod['id']),'b')
    # Rendered stale authorization shows useful errors from an actual denied request.
    code('open-before-permission-change', '''await page.getByRole('button',{name:'Edit',exact:true}).click();return true;''')
    sql('permission-change',f'''UPDATE domain."Beat" SET "authorId"='{b}' WHERE id='{source['id']}';''')
    code('rendered-permission-error', '''
      await page.getByPlaceholder('Enter beat name').first().fill('Denied edit');await page.locator('.btn-create').first().click();
      await page.getByRole('alert').filter({hasText:'Sign in as its author'}).waitFor();return true;
    ''')
    assert any(r['status']==403 and '/_server/' in r['url'] for r in CHECKS['rendered-permission-error']['network'])
    sql('permission-restored',f'''UPDATE domain."Beat" SET "authorId"='{a}' WHERE id='{source['id']}';''')
    code('switch-clears-editor', '''
      await page.getByPlaceholder('Enter beat name').first().fill('Stale edit draft');
      await page.evaluate(async()=>{const c=(await import('/_build/src/server/auth-runtime/client.ts')).authClient;await c.signOut();await c.signIn.username({username:'contentb',password:'Content-fixture-password-123!'});});
      await page.getByText('Only the module author can create beats here.',{exact:true}).waitFor();
      check(await page.getByPlaceholder('Enter beat name').count()===0,'editor cleared');return true;
    ''')
    code('switch-back-clean-editor', '''
      await page.evaluate(async()=>{const c=(await import('/_build/src/server/auth-runtime/client.ts')).authClient;await c.signOut();await c.signIn.username({username:'contenta',password:'Content-fixture-password-123!'});});
      const edit=page.getByRole('button',{name:'Edit',exact:true});await edit.waitFor();await edit.click();
      check(await page.getByPlaceholder('Enter beat name').first().inputValue()==='Rendered edit','stale edit draft removed');return true;
    ''')
    sql('expire-a',f"UPDATE auth.session SET expires_at=now()-interval '1 day' WHERE user_id='{a}'")
    denied('expired-session',401)
    sql('revoke-b',f"DELETE FROM auth.session WHERE user_id='{b}'")
    denied('revoked-session',401,'b')
    evaluate('clear-retry', '''await fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return true;''')
    # Install failure before signup: the live session observer may provision immediately.
    sql('fail-profile', '''CREATE FUNCTION domain.edit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable profile failure'; END $$; CREATE TRIGGER edit_fail BEFORE INSERT ON domain."User" FOR EACH ROW EXECUTE FUNCTION domain.edit_fail();''')
    retry=evaluate('retry-signup', '''const name='editretry';const r=await fetch('/api/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,name,email:name+'@example.test',password:'Content-fixture-password-123!'})});if(!r.ok)throw new Error('signup');return (await r.json()).user.id;''')
    before_profile=state('before-profile-failure');denied('profile-failure',503)
    assert state('after-profile-failure')==before_profile
    sql('repair-profile','DROP TRIGGER edit_fail ON domain."User"; DROP FUNCTION domain.edit_fail();')
    # Retry provisions the profile, then correctly denies access to another author's beat.
    denied('profile-retry-denied',403)
    assert sql('profile-recovered',f'''SELECT count(*) FROM domain."User" WHERE id='{retry}';''')=='1'
    mr=sf('retry-method','createMethodServerFn',{'title':'Retry method'})
    modr=sf('retry-module','createModuleServerFn',{'title':'Retry module','methodId':mr['id']})
    br=sf('retry-beat','createBeatServerFn',{'name':'Retry beat','moduleId':modr['id'],'beatNotes':notes})
    result=sf('retry-edit','saveBeatServerFn',{**edit,'id':br['id'],'moduleId':modr['id']})
    assert result['authorId']==retry
    code('forged-cookie', '''await page.context().clearCookies();await page.context().addCookies([{name:'better-auth.session_token',value:'forged',url:base}]);return true;''')
    denied('forged-session',401)
    code('public-browsing-signin', '''
      await page.goto(base+'/module/MODULE');await page.getByText('Rendered edit',{exact:true}).waitFor();
      await page.getByRole('link',{name:'Sign in to edit',exact:true}).click();
      await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();return true;
    '''.replace('MODULE',mod['id']))
    assert history('history-final')==baseline_history
    assert sql('unrelated-final',f'''SELECT row_to_json(b)::text FROM domain."Beat" b WHERE id='{other['id']}';''')==unrelated
    assert sql('unrelated-notes-final',f'''SELECT row_to_json(b)::text FROM domain."BeatNote" b WHERE "beatId"='{other['id']}' ORDER BY id;''')==unrelated_notes
    for session in ['a','b']:
        cli('console-'+session,'console',session=session);cli('requests-'+session,'requests',session=session)
    print(f'PASS existing beat editing: {OUT / "beat-edit-assertions.json"}',flush=True)
finally:
    for session in ['a','b']:
        cli('close-'+session,'close',session=session)
