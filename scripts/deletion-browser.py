"""Deletion proof; reuse the existing real server-function/browser fixture driver."""
import importlib.util
import json
import sys
sys.dont_write_bytecode = True
from pathlib import Path

spec = importlib.util.spec_from_file_location('beat_edit_proof', Path(__file__).with_name('beat-edit-browser.py'))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
# Retain distinct command/assertion files without changing the shared fixture driver.


def calls(kind, id):
    return [['delete' + kind.title() + 'ServerFn', {'id': id}]]


def api(label, kind, id, status, session='a', extra=None):
    path = '/api/modules' if kind == 'module' else '/api/beats/' + id
    body = {'id': id, **(extra or {})} if kind == 'module' else None
    result = f.evaluate(label, '''
      const options={method:'DELETE',headers:{'Content-Type':'application/json'}};
      if(BODY!==null)options.body=JSON.stringify(BODY);
      const r=await fetch(PATH,options);return {status:r.status,body:await r.text()};
    '''.replace('BODY', json.dumps(body)).replace('PATH', json.dumps(path)), session)
    assert result['status'] == status, result


def snapshot(label):
    return [f.sql(label+'-'+table, f'SELECT row_to_json(t)::text FROM domain."{table}" t ORDER BY id')
            for table in ['User','Method','Module','Beat','BeatNote','Performance','BeatProgress','ModuleProgress','MethodProgress']]


try:
    for session in ['a','b']:
        f.cli('open-'+session,'open',f.BASE+'/methods',session=session)
        f.cli('snapshot-'+session,'snapshot',session=session)
    for kind in ['beat','module','method']:
        f.rejected('missing-'+kind,calls(kind,'absent'),401)
    api('missing-beat-api','beat','absent',401)
    api('missing-module-api','module','absent',401)
    a=f.signup('a');b=f.signup('b')
    def method(label, session='a'):
        return f.sf(label,'createMethodServerFn',{'title':label},session)
    def module(label, parent, session='a'):
        return f.sf(label,'createModuleServerFn',{'title':label,'methodId':parent['id']},session)
    def beat(label, parent, session='a'):
        notes=[{'index':n,'duration':8,'noteString':'kick','barNum':0,'beatNum':n//2,'divisionNum':n%2,'subDivisionNum':0,'numSubDivisions':1,'velocity':100,'microtiming':0} for n in range(8)]
        return f.sf(label,'createBeatServerFn',{'name':label,'moduleId':parent['id'],'beatNotes':notes},session)
    keep=method('Surviving method');km=module('Surviving module',keep);kb=beat('Surviving beat',km)
    def tree(label):
        m=method(label);mod=module(label+' module',m);bt=beat(label+' beat',mod)
        for user in [a,b]:
            f.sql(label+'-history-'+user, f'''INSERT INTO domain."MethodProgress" (id,"userId","methodId","updatedAt") VALUES ('mp-{m['id']}-{user}','{user}','{m['id']}',now());
            INSERT INTO domain."ModuleProgress" (id,"userId","moduleId","currentMethodId","updatedAt") VALUES ('modp-{mod['id']}-{user}','{user}','{mod['id']}','{m['id']}',now());
            INSERT INTO domain."BeatProgress" (id,"userId","beatId","updatedAt") VALUES ('bp-{bt['id']}-{user}','{user}','{bt['id']}',now());
            INSERT INTO domain."Performance" (id,"userId","beatId",index,"modifiedAt") VALUES ('perf-{bt['id']}-{user}','{user}','{bt['id']}',0,now());
            INSERT INTO domain."BeatNote" (id,index,duration,"noteString","barNum","beatNum","divisionNum","subDivisionNum","numSubDivisions",velocity,"beatId","performanceId") VALUES ('note-{bt['id']}-{user}',0,8,'kick',0,0,0,0,1,80,'{kb['id']}','perf-{bt['id']}-{user}');
            UPDATE domain."User" SET "currentModuleId"='{mod['id']}' WHERE id='{user}';''')
        return m,mod,bt
    # Unrelated history must retain its notes even when a dual relation points into deleted content.
    f.sql('keep-performance',f'''INSERT INTO domain."Performance" (id,"userId","beatId",index,"modifiedAt") VALUES ('keep-performance','{b}','{kb['id']}',0,now());''')
    auth_before=f.sql('auth-before', 'SELECT row_to_json(t)::text FROM auth."user" t ORDER BY id')
    sessions_before=f.sql('sessions-before', 'SELECT row_to_json(t)::text FROM auth.session t ORDER BY id')
    migrations_before=f.sql('migrations-before', 'SELECT row_to_json(t)::text FROM auth_migrations.__drizzle_migrations t ORDER BY id')
    m,mod,bt=tree('Beat deletion')
    for kind,item in [('method',m),('module',mod),('beat',bt)]:
        f.rejected('nonowner-'+kind,calls(kind,item['id']),403,'b')
        for key,value in {'authorId':a,'userId':a,'role':'admin','token':'forged','enableAdmin':True}.items():
            f.rejected('forged-'+kind+'-'+key,[[calls(kind,item['id'])[0][0],{'id':item['id'],key:value}]],500)
    api('nonowner-beat','beat',bt['id'],403,'b');api('nonowner-module','module',mod['id'],403,'b')
    api('forged-api-module','module',mod['id'],400,extra={'role':'admin'})
    before=snapshot('before-rollback')
    f.sql('fail-delete','''CREATE FUNCTION domain.fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deliberate deletion failure'; END $$; CREATE TRIGGER fail_delete BEFORE DELETE ON domain."Beat" FOR EACH ROW EXECUTE FUNCTION domain.fail_delete();''')
    for kind,item in [('beat',bt),('module',mod),('method',m)]:
        f.rejected('rollback-'+kind,calls(kind,item['id']),500)
        assert snapshot('after-rollback-'+kind)==before
    f.sql('repair-delete','DROP TRIGGER fail_delete ON domain."Beat"; DROP FUNCTION domain.fail_delete();')
    # Concurrent ownership change is observed after the blocking writer commits.
    f.concurrent('delete-owner-change',f'''UPDATE domain."Beat" SET "authorId"='{b}' WHERE id='{bt['id']}';''',lambda:f.rejected('changed-owner',calls('beat',bt['id']),403))
    f.sql('restore-owner',f'''UPDATE domain."Beat" SET "authorId"='{a}' WHERE id='{bt['id']}';''')
    # Cancellation must send no mutation; persisted Admin mode is not required.
    f.code('prepare-confirmation', '''
      await page.goto(base+'/module/MODULE');await page.getByRole('button',{name:'Delete',exact:true}).waitFor();
      await page.evaluate(()=>{window.deletionRequests=[];window.originalFetch=window.fetch;window.fetch=(...args)=>{window.deletionRequests.push(String(args[0]));return window.originalFetch(...args);};});return true;
    '''.replace('MODULE',mod['id']))
    modal=f.cli('cancel-click','run-code',"async (page)=>{await page.getByRole('button',{name:'Delete',exact:true}).click();}")
    assert 'every user' in modal and 'practice history' in modal,modal
    f.cli('cancel-dialog','dialog-dismiss')
    f.code('cancel-confirmation', '''
      const requests=await page.evaluate(()=>{const requests=window.deletionRequests;window.fetch=window.originalFetch;return requests;});
      check(!requests.some(r=>r.includes('--delete')),'cancellation sent mutation');return requests;
    ''')
    f.cli('confirmation','screenshot','--filename',str(f.ARTIFACTS/'deletion-controls.png'))
    assert snapshot('after-cancel')==before
    f.cli('accept-beat-click','run-code',"async (page)=>{await page.getByRole('button',{name:'Delete',exact:true}).click();}")
    f.cli('accept-beat-dialog','dialog-accept')
    f.code('rendered-beat-delete', '''
      await page.getByText('Beat deletion beat',{exact:true}).waitFor({state:'hidden'});return true;
    ''')
    assert f.sql('beat-cleaned',f'''SELECT (SELECT count(*) FROM domain."Beat" WHERE id='{bt['id']}')+(SELECT count(*) FROM domain."Performance" WHERE "beatId"='{bt['id']}')+(SELECT count(*) FROM domain."BeatProgress" WHERE "beatId"='{bt['id']}')+(SELECT count(*) FROM domain."BeatNote" WHERE id LIKE '%{bt['id']}%');''')=='0'
    # Module deletion via API, then method deletion via server function, including references on surviving rows.
    m2,mod2,bt2=tree('Module deletion')
    f.sql('dual-survivor',f'''INSERT INTO domain."BeatNote" (id,index,duration,"noteString","barNum","beatNum","divisionNum","subDivisionNum","numSubDivisions",velocity,"beatId","performanceId") VALUES ('surviving-note',0,8,'kick',0,0,0,0,1,80,'{bt2['id']}','keep-performance');''')
    # A committed insertion immediately before deletion belongs to the protected descendant set.
    f.concurrent('concurrent-insert',f'''INSERT INTO domain."Beat" (id,name,index,"authorId","moduleId","modifiedAt") VALUES ('concurrent-beat','Concurrent',0,'{a}','{mod2['id']}',now());''',lambda:api('delete-module','module',mod2['id'],200))
    assert f.sql('module-cleaned',f'''SELECT (SELECT count(*) FROM domain."Beat" WHERE "moduleId"='{mod2['id']}')+(SELECT count(*) FROM domain."Module" WHERE id='{mod2['id']}')+(SELECT count(*) FROM domain."User" WHERE "currentModuleId"='{mod2['id']}')+(SELECT count(*) FROM domain."ModuleProgress" WHERE "moduleId"='{mod2['id']}');''')=='0'
    assert f.sql('dual-survives','''SELECT count(*) FROM domain."BeatNote" WHERE id='surviving-note' AND "beatId" IS NULL AND "performanceId"='keep-performance';''')=='1'
    m3,mod3,bt3=tree('Method deletion')
    f.sql('cross-reference',f'''INSERT INTO domain."ModuleProgress" (id,"userId","moduleId","currentMethodId","updatedAt") VALUES ('cross-reference','{b}','{km['id']}','{m3['id']}',now());''')
    f.sf('delete-method','deleteMethodServerFn',{'id':m3['id']})
    assert f.sql('method-cleaned',f'''SELECT (SELECT count(*) FROM domain."Method" WHERE id='{m3['id']}')+(SELECT count(*) FROM domain."MethodProgress" WHERE "methodId"='{m3['id']}')+(SELECT count(*) FROM domain."ModuleProgress" WHERE "currentMethodId"='{m3['id']}')+(SELECT count(*) FROM domain."BeatNote" WHERE id LIKE '%{bt3['id']}%');''')=='0'
    assert f.sql('preserved',f'''SELECT (SELECT count(*) FROM auth."user")=2 AND (SELECT count(*) FROM auth.session)=2 AND (SELECT count(*) FROM domain."User")=2 AND EXISTS(SELECT FROM domain."Method" WHERE id='{keep['id']}') AND EXISTS(SELECT FROM domain."Performance" WHERE id='keep-performance') AND EXISTS(SELECT FROM domain."Module" WHERE id='{mod['id']}');''')=='t'
    # Alternate API success and rendered module/method deletion refresh paths.
    api_beat=beat('API deletion',km)
    api('owner-api-beat','beat',api_beat['id'],200)
    rm,rmod,rbeat=tree('Rendered deletion')
    f.code('prepare-module-delete', '''
      await page.goto(base+'/method/METHOD');await page.getByRole('button',{name:'Delete',exact:true}).waitFor();return true;
    '''.replace('METHOD',rm['id']))
    modal=f.cli('module-delete-click','run-code',"async (page)=>{await page.getByRole('button',{name:'Delete',exact:true}).click();}")
    assert 'practice history' in modal,modal
    f.cli('module-dialog','dialog-accept')
    f.code('rendered-module-delete', '''
      await page.getByText('No modules available for this method.',{exact:true}).waitFor();return true;
    ''')
    f.code('prepare-method-delete', '''
      await page.goto(base+'/methods');await page.getByRole('link',{name:'Rendered deletion',exact:true}).waitFor();return true;
    ''')
    modal=f.cli('method-delete-click','run-code',"async (page)=>{await page.locator('li').filter({has:page.getByRole('link',{name:'Rendered deletion',exact:true})}).getByRole('button',{name:'Delete',exact:true}).click();}")
    assert 'every user' in modal,modal
    f.cli('method-dialog','dialog-accept')
    f.code('rendered-method-delete', '''
      await page.getByRole('link',{name:'Rendered deletion',exact:true}).waitFor({state:'hidden'});return true;
    ''')
    assert f.sql('rendered-cleaned',f'''SELECT (SELECT count(*) FROM domain."Method" WHERE id='{rm['id']}')+(SELECT count(*) FROM domain."Beat" WHERE id='{rbeat['id']}');''')=='0'
    # Concurrent moves committed before the lock are reflected in descendant selection.
    cm,cmod,cb=tree('Concurrent moves')
    f.concurrent('move-out',f'''UPDATE domain."Beat" SET "moduleId"='{km['id']}' WHERE id='{cb['id']}';''',lambda:f.sf('delete-after-move','deleteModuleServerFn',{'id':cmod['id']}))
    assert f.sql('moved-out-preserved',f'''SELECT count(*) FROM domain."Beat" WHERE id='{cb['id']}' AND "moduleId"='{km['id']}';''')=='1'
    # Insertion started after descendant selection must wait, then fail its FK.
    import concurrent.futures
    import subprocess
    import time
    lm,lmod,lbeat=tree('Locked insertion')
    f.sql('slow-delete', '''CREATE FUNCTION domain.slow_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN OLD; END $$; CREATE TRIGGER slow_delete BEFORE DELETE ON domain."Beat" FOR EACH ROW EXECUTE FUNCTION domain.slow_delete();''')
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        deletion=pool.submit(f.sf,'locked-delete','deleteModuleServerFn',{'id':lmod['id']})
        for attempt in range(100):
            ready=f.sql('locked-ready-'+str(attempt),"SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%Beat%';")
            if ready!='0':break
            time.sleep(0.05)
        else:raise RuntimeError('deletion did not hold the lock')
        assert f.sql('descendant-table-lock',"SELECT count(*) FROM pg_locks WHERE relation='domain.\"Beat\"'::regclass AND mode='ShareRowExclusiveLock' AND granted;")=='1'
        args=['psql',f.TARGET['database'],'-v','ON_ERROR_STOP=1','-c',f'''INSERT INTO domain."Beat" (id,name,index,"authorId","moduleId","modifiedAt") VALUES ('too-late','Late',0,'{a}','{lmod['id']}',now());''']
        result=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        path=f.ARTIFACTS/'concurrent-late-insert.log';path.write_text(result.stdout)
        f.COMMANDS.append({'command':args,'exit':result.returncode,'log':str(path),'expected':'foreign key rejection after deletion'})
        assert result.returncode!=0 and 'foreign key' in result.stdout,result.stdout
        assert deletion.result()=={'success':True}
    f.sql('remove-slow-delete','DROP TRIGGER slow_delete ON domain."Beat"; DROP FUNCTION domain.slow_delete();')
    assert f.sql('late-insert-absent','SELECT count(*) FROM domain."Beat" WHERE id=\'too-late\';')=='0'
    assert f.sql('auth-after', 'SELECT row_to_json(t)::text FROM auth."user" t ORDER BY id')==auth_before
    assert f.sql('sessions-after', 'SELECT row_to_json(t)::text FROM auth.session t ORDER BY id')==sessions_before
    assert f.sql('migrations-after', 'SELECT row_to_json(t)::text FROM auth_migrations.__drizzle_migrations t ORDER BY id')==migrations_before
    # Account switch clears method selection; new identity cannot delete previous user's rows.
    f.code('switch-account', '''
      await page.goto(base+'/methods');await page.getByRole('button',{name:'Edit',exact:true}).first().waitFor();
      await page.getByRole('button',{name:'Edit',exact:true}).first().click();
      await page.evaluate(async()=>{const c=(await import('/src/server/auth-runtime/client.ts')).authClient;await c.signOut();await c.signIn.username({username:'contentb',password:'Content-fixture-password-123!'});});
      await page.getByRole('button',{name:'Save',exact:true}).waitFor({state:'hidden'});return true;
    ''')
    f.rejected('switched-denied',calls('method',keep['id']),403)
    f.sql('expire',f"UPDATE auth.session SET expires_at=now()-interval '1 day' WHERE user_id='{b}'")
    for kind,id in [('method',keep['id']),('module',km['id']),('beat',kb['id'])]:
        f.rejected('expired-'+kind,calls(kind,id),401)
    api('expired-api-module','module',km['id'],401);api('expired-api-beat','beat',kb['id'],401)
    f.evaluate('relogin', '''const r=await fetch('/api/auth/sign-in/username',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'contentb',password:'Content-fixture-password-123!'})});if(!r.ok)throw new Error('login');return true;''')
    f.sql('revoke',f"DELETE FROM auth.session WHERE user_id='{b}'")
    for kind,id in [('method',keep['id']),('module',km['id']),('beat',kb['id'])]:
        f.rejected('revoked-'+kind,calls(kind,id),401)
    api('revoked-api-module','module',km['id'],401);api('revoked-api-beat','beat',kb['id'],401)
    f.code('forge-cookie', '''await page.context().clearCookies();await page.context().addCookies([{name:'better-auth.session_token',value:'forged',url:base}]);return true;''')
    for kind,id in [('method',keep['id']),('module',km['id']),('beat',kb['id'])]:
        f.rejected('forged-session-'+kind,calls(kind,id),401)
    api('forged-cookie-module','module',km['id'],401);api('forged-cookie-beat','beat',kb['id'],401)
    f.sql('fail-profile', '''CREATE FUNCTION domain.delete_profile_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture profile failure'; END $$; CREATE TRIGGER delete_profile_fail BEFORE INSERT ON domain."User" FOR EACH ROW EXECUTE FUNCTION domain.delete_profile_fail();''')
    f.code('clear-cookie', 'await page.context().clearCookies();return true;')
    retry=f.evaluate('retry-signup', '''const name='deleteretry';const r=await fetch('/api/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,name,email:name+'@example.test',password:'Content-fixture-password-123!'})});if(!r.ok)throw new Error('signup');return (await r.json()).user.id;''')
    for kind,id in [('method',keep['id']),('module',km['id']),('beat',kb['id'])]:
        f.rejected('profile-failure-'+kind,calls(kind,id),503)
    api('profile-failure-module','module',km['id'],503);api('profile-failure-beat','beat',kb['id'],503)
    f.sql('repair-profile','DROP TRIGGER delete_profile_fail ON domain."User"; DROP FUNCTION domain.delete_profile_fail();')
    f.rejected('profile-retry',calls('beat',kb['id']),403)
    assert f.sql('retry-profile',f'''SELECT count(*) FROM domain."User" WHERE id='{retry}';''')=='1'
    for session in ['a','b']:
        f.cli('console-'+session,'console',session=session);f.cli('network-'+session,'requests',session=session)
    print('PASS deletion proof: '+str(f.OUT),flush=True)
finally:
    for session in ['a','b']:
        f.cli('close-'+session,'close',session=session)
    for source,dest in [('beat-edit-commands.json','deletion-commands.json'),('beat-edit-assertions.json','deletion-assertions.json')]:
        p=f.OUT/source
        if p.exists():(f.OUT/dest).write_text(p.read_text())
