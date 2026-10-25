"""Private practice proof through actual browser modules/server functions and disposable SQL."""
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
    (OUT / 'practice-commands.json').write_text(json.dumps(COMMANDS, indent=2))
    if result.returncode or '### Error' in result.stdout:
        raise RuntimeError(f'{label} failed: {log}')
    return result.stdout


def cli(label, *args, session='a'):
    return command(label, [CLI, '--session', 'private-6e88-' + session, *args], ARTIFACTS)


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
        window.practice = {
          ...await import('/_build/src/services/performanceService.server.ts'),
          ...await import('/_build/src/services/userProgressServerService.server.ts'),
          ...await import('/_build/src/services/beatService.server.ts'),
        };
        window.nav = (await import('/_build/src/state/NavigationStore.ts')).useNavigationStore;
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
    (OUT / 'practice-assertions.json').write_text(json.dumps(CHECKS, indent=2))
    return result['value']


def sql(label, statement):
    return command(label, ['psql', TARGET['database'], '-v', 'ON_ERROR_STOP=1', '-Atc', statement]).strip()


def modules(session='a'):
    return code('modules-' + session, '''
      return page.evaluate(async () => {
        window.practice = {
          ...await import('/_build/src/services/performanceService.server.ts'),
          ...await import('/_build/src/services/userProgressServerService.server.ts'),
          ...await import('/_build/src/services/beatService.server.ts'),
        };
        window.nav = (await import('/_build/src/state/NavigationStore.ts')).useNavigationStore;
        return Object.keys(window.practice);
      });
    ''', session)


def signup(session):
    return code('signup-' + session, '''
      const user = await page.evaluate(async name => {
        const r = await fetch('/api/auth/sign-up/email', {method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({username:name,name,email:name+'@example.test',password:'Private-fixture-password-123!'})});
        if (!r.ok) throw new Error('signup failed'); return (await r.json()).user.id;
      }, NAME);
      return user;
    '''.replace('NAME', json.dumps('practice' + session)), session)


def matrix(label, session='a'):
    result = code(label, '''
      return page.evaluate(async () => {
        const calls = [
          ['fetchUserPerformancesForBeatServerFn',{beatId:'practice-beat'}],
          ['getBeatWithPerformancesServerFn',{beatId:'practice-beat'}],
          ['getBeatProgressForModuleServerFn',{id:'practice-module'}],
          ['startBeatServerFn',{beatId:'practice-beat'}],
          ['passBeatTempoServerFn',{beatId:'practice-beat',tempo:333}],
          ['savePerformanceServerFn',{performance:{beatId:'practice-beat',index:0,notes:[]}}],
          ['deletePerformancesByBeatIdAndUserId',{beatId:'practice-beat'}],
        ];
        const results = [];
        for (const [name,data] of calls) {
          if(typeof window.practice?.[name] !== 'function') throw new Error('missing browser function '+name);
          try { const result = await window.practice[name]({data}); throw new Error('unexpected acceptance '+name+JSON.stringify(result)); }
          catch (e) { if (e instanceof TypeError || e.message?.startsWith('unexpected acceptance')) throw e; results.push({name,error:String(e)}); }
        }
        return results;
      });
    ''', session)
    responses = [row for row in CHECKS[label]['network'] if '/_server/' in row['url']]
    expected = 503 if label == 'provisioning-failure' else 401
    assert len(responses) == 7 and all(row['status'] == expected for row in responses), responses
    return result


try:
    for session in ['a', 'b']:
        cli('open-' + session, 'open', BASE + '/auth/login', session=session)
        cli('initial-' + session, 'snapshot', session=session)
        modules(session)
    matrix('missing-session')
    a = signup('a')
    b = signup('b')
    for session in ['a', 'b']:
        code('provision-' + session, '''
          const result = await page.evaluate(async()=>{const r=await fetch('/api/session');return {status:r.status,data:await r.json()};});
          check(result.status===200,'trusted profile'); return result;
        ''', session)
    sql('content-fixture', f'''INSERT INTO domain."Method" (id,title,index,"authorId","modifiedAt") VALUES ('practice-method','Private fixture',0,'{a}',now());
      INSERT INTO domain."Module" (id,title,index,"authorId","methodId","modifiedAt") VALUES ('practice-module','Practice fixture',0,'{a}','practice-method',now());
      INSERT INTO domain."Beat" (id,name,index,"authorId","moduleId","modifiedAt") VALUES ('practice-beat','Practice beat',0,'{a}','practice-module',now()),('unrelated-beat','Unrelated beat',1,'{a}','practice-module',now());
      INSERT INTO domain."BeatNote" (id,index,duration,"noteString","barNum","beatNum","divisionNum","subDivisionNum","numSubDivisions",velocity,microtiming,"beatId") VALUES ('content-note',0,1,'36',0,0,0,0,1,100,0,'practice-beat');''')
    for session, tempo in [('a', 140), ('b', 90)]:
        code('owner-writes-' + session, '''
          return page.evaluate(async tempo => {
            const p = window.practice;
            await p.startBeatServerFn({data:{beatId:'practice-beat'}});
            await p.passBeatTempoServerFn({data:{beatId:'practice-beat',tempo}});
            await p.passBeatTempoServerFn({data:{beatId:'practice-beat',tempo:tempo-10}});
            const note = {id:'note-'+tempo,index:0,noteString:'38',barNum:1,beatNum:2,divisionNum:0,subDivisionNum:1,numSubDivisions:4,velocity:99,microtiming:-7,duration:2};
            const saved = await p.savePerformanceServerFn({data:{performance:{beatId:'practice-beat',index:7,notes:[note]}}});
            if (saved.notes[0].microtiming!==-7 || saved.index!==7) throw new Error('note/index semantics');
            await p.savePerformanceServerFn({data:{performance:{beatId:'unrelated-beat',index:0,notes:[]}}});
            return saved;
          }, TEMPO);
        '''.replace('TEMPO', str(tempo)), session)
    for session, user, tempo in [('a', a, 140), ('b', b, 90)]:
        code('isolation-' + session, '''
          return page.evaluate(async expected => {
            const p=window.practice;
            const recordings=await p.fetchUserPerformancesForBeatServerFn({data:{beatId:'practice-beat'}});
            const beat=await p.getBeatWithPerformancesServerFn({data:{beatId:'practice-beat'}});
            const progress=await p.getBeatProgressForModuleServerFn({data:{id:'practice-module'}});
            if(recordings.length!==1 || recordings[0].userId!==expected.user || beat.performances[0].userId!==expected.user || progress.find(x=>x.beatId==='practice-beat').bestTempo!==expected.tempo) throw new Error('private isolation');
            return {recordings,beat,progress};
          }, EXPECTED);
        '''.replace('EXPECTED', json.dumps({'user': user, 'tempo': tempo})), session)
    code('forged-ownership', '''
      return page.evaluate(async other => {
        const p=window.practice;
        const attempts=[
          ['fetchUserPerformancesForBeatServerFn',{beatId:'practice-beat',userId:other}],
          ['getBeatWithPerformancesServerFn',{beatId:'practice-beat',token:'forged'}],
          ['getBeatProgressForModuleServerFn',{id:'practice-module',userId:other}],
          ['startBeatServerFn',{beatId:'practice-beat',userId:other}],
          ['passBeatTempoServerFn',{beatId:'practice-beat',tempo:999,userId:other}],
          ['savePerformanceServerFn',{performance:{beatId:'practice-beat',index:0,notes:[],userId:other}}],
          ['deletePerformancesByBeatIdAndUserId',{beatId:'practice-beat',userId:other}],
          ['fetchUserPerformancesForBeatServerFn',{beatId:'practice-beat',email:'practiceb@example.test',enableAdmin:true}],
        ];
        for(const [name,data] of attempts) {
          let denied=false;try{await p[name]({data});}catch{denied=true;}
          if(!denied)throw new Error('forged ownership accepted '+name);
        }
        const own = await p.fetchUserPerformancesForBeatServerFn({data:{beatId:'practice-beat'},headers:{Authorization:'Bearer forged','x-user-id':other}});
        if(own.length!==1 || own[0].userId===other)throw new Error('browser headers selected another owner');
        return {rejected:attempts.map(([name])=>name), forgedHeadersIgnored:true, owner:own[0].userId};
      }, OTHER);
    '''.replace('OTHER', json.dumps(b)))
    before = sql('before-rollback', '''SELECT row_to_json(p)::text FROM domain."Performance" p ORDER BY id; SELECT row_to_json(n)::text FROM domain."BeatNote" n ORDER BY id;''')
    code('replacement-rollback', '''
      return page.evaluate(async()=>{
        const note={id:'content-note',index:0,noteString:'36',barNum:0,beatNum:0,divisionNum:0,subDivisionNum:0,numSubDivisions:1,velocity:100,microtiming:0,duration:1};
        let denied=false;try{await window.practice.savePerformanceServerFn({data:{performance:{beatId:'practice-beat',index:0,notes:[note]}}});}catch{denied=true;}
        if(!denied)throw new Error('duplicate note unexpectedly committed');return {createFailureRejected:true};
      });
    ''')
    assert before == sql('after-rollback', '''SELECT row_to_json(p)::text FROM domain."Performance" p ORDER BY id; SELECT row_to_json(n)::text FROM domain."BeatNote" n ORDER BY id;'''), 'rollback changed rows'
    code('replacement-and-delete', '''
      return page.evaluate(async()=>{
        const p=window.practice;
        await Promise.all([1,2].map(index=>p.savePerformanceServerFn({data:{performance:{beatId:'practice-beat',index,notes:[]}}})));
        const rows=await p.fetchUserPerformancesForBeatServerFn({data:{beatId:'practice-beat'}});
        if(rows.length!==1)throw new Error('replacement concurrency');
        await p.deletePerformancesByBeatIdAndUserId({data:{beatId:'practice-beat'}});
        if((await p.fetchUserPerformancesForBeatServerFn({data:{beatId:'practice-beat'}})).length)throw new Error('delete');return true;
      });
    ''')
    assert sql('note-history-preservation', '''SELECT id FROM domain."BeatNote" ORDER BY id''').splitlines() == ['content-note', 'note-90']
    assert sql('unrelated-history', '''SELECT count(*) FROM domain."Performance" WHERE "beatId"='unrelated-beat' ''') == '2'
    sql('expire-a', f"UPDATE auth.session SET expires_at=now()-interval '1 day' WHERE user_id='{a}'")
    matrix('expired-session')
    sql('revoke-b', f"DELETE FROM auth.session WHERE user_id='{b}'")
    matrix('revoked-session', 'b')
    # Valid identity, unavailable profile: every dependent path must fail closed and retry.
    code('retry-account', '''
      await page.evaluate(async()=>{await fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});});
      return true;
    ''')
    retry = code('retry-signup', '''
      return page.evaluate(async()=>{const r=await fetch('/api/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'practiceretry',name:'practiceretry',email:'practiceretry@example.test',password:'Private-fixture-password-123!'})});return (await r.json()).user.id;});
    ''')
    sql('fail-profile', '''CREATE FUNCTION domain.practice_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable provisioning failure'; END $$; CREATE TRIGGER practice_fail BEFORE INSERT ON domain."User" FOR EACH ROW EXECUTE FUNCTION domain.practice_fail();''')
    matrix('provisioning-failure')
    sql('repair-profile', 'DROP TRIGGER practice_fail ON domain."User"; DROP FUNCTION domain.practice_fail();')
    code('profile-retry', '''
      return page.evaluate(async()=>{const result=await window.practice.startBeatServerFn({data:{beatId:'practice-beat'}});if(!result.success)throw new Error('retry failed');return result;});
    ''')
    assert sql('trusted-retry-id', f'''SELECT "currentModuleId" FROM domain."User" WHERE id='{retry}' ''') == 'practice-module'
    sql('renderable-score-fixture', '''UPDATE domain."BeatNote" SET duration=8,"noteString"='kick' WHERE id='content-note';
      INSERT INTO domain."BeatNote" (id,index,duration,"noteString","barNum","beatNum","divisionNum","subDivisionNum","numSubDivisions",velocity,microtiming,"beatId")
      SELECT 'render-practice-'||n,n,8,'kick',0,n/2,n%2,0,1,100,0,'practice-beat' FROM generate_series(1,7) n;
      INSERT INTO domain."BeatNote" (id,index,duration,"noteString","barNum","beatNum","divisionNum","subDivisionNum","numSubDivisions",velocity,microtiming,"beatId")
      SELECT 'render-unrelated-'||n,n,8,'kick',0,n/2,n%2,0,1,100,0,'unrelated-beat' FROM generate_series(0,7) n;''')
    # Render the real module and transport; the selected fixture has real score notes.
    code('rendered-practice', '''
      await page.goto(base+'/module/practice-module');
      await page.getByText('Practice beat',{exact:true}).waitFor();
      await page.getByRole('link',{name:'Practice account',exact:true}).waitFor();
      await page.getByRole('button',{name:'140',exact:true}).first().click();
      await page.getByRole('button',{name:'Record',exact:true}).waitFor();
      await page.getByRole('button',{name:'Record',exact:true}).click();
      await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
      await page.getByRole('button',{name:'Stop',exact:true}).click();
      await page.locator('.transport-controls').getByRole('button',{name:'Save',exact:true}).click();
      await page.getByRole('button',{name:'Delete 1 recordings',exact:true}).waitFor();
      return {realModule:true,record:true,stop:true,save:true};
    ''')
    cli('saved-screenshot','screenshot','--filename',str(ARTIFACTS/'saved-practice.png'))
    modules()
    code('cache-before-switch', '''
      const result=await page.evaluate(()=>({user:window.nav.getState().practiceUserId,cache:Object.values(window.nav.getState().performancesByBeatId).flat().length}));
      check(result.cache===1,'saved recording cached');return result;
    ''')
    code('switch-account', '''
      await page.evaluate(async()=>{
        const client=(await import('/_build/src/server/auth-runtime/client.ts')).authClient;
        await client.signOut();
      });
      await page.waitForFunction(()=>window.nav.getState().practiceUserId===null && Object.keys(window.nav.getState().performancesByBeatId).length===0 && window.nav.getState().currentPerformance===null);
      await page.evaluate(async()=>{
        const client=(await import('/_build/src/server/auth-runtime/client.ts')).authClient;
        await client.signIn.username({username:'practiceb',password:'Private-fixture-password-123!'});
      });
      await page.waitForFunction(expected=>window.nav.getState().practiceUserId===expected, OTHER);
      await page.waitForFunction(()=>Object.values(window.nav.getState().performancesByBeatId).flat().every(p=>p.userId===window.nav.getState().practiceUserId));
      return page.evaluate(()=>({user:window.nav.getState().practiceUserId,cache:window.nav.getState().performancesByBeatId,current:window.nav.getState().currentPerformance}));
    '''.replace('OTHER',json.dumps(b)))
    sql('rendered-revoke', f"DELETE FROM auth.session WHERE user_id='{b}'")
    code('session-loss-cache-clear', '''
      await page.getByRole('link',{name:'Sign in to save practice',exact:true}).waitFor();
      const state=await page.evaluate(()=>({user:window.nav.getState().practiceUserId,cache:window.nav.getState().performancesByBeatId,current:window.nav.getState().currentPerformance}));
      check(state.user===null && Object.keys(state.cache).length===0 && state.current===null,'session loss clears private caches');
      check(await page.getByRole('link',{name:'Sign in to save recordings',exact:true}).isVisible(),'persistence sign-in access');
      await page.getByRole('button',{name:'Play',exact:true}).click();
      await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
      await page.getByRole('button',{name:'Stop',exact:true}).click();
      await page.getByRole('button',{name:'Record',exact:true}).click();
      await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
      await page.getByRole('button',{name:'Stop',exact:true}).click();
      check(await page.locator('.transport-controls').getByRole('button',{name:'Save',exact:true}).count()===0,'anonymous persistence hidden');
      return {state,anonymousPlayback:true,anonymousRecord:true};
    ''')
    cli('anonymous-screenshot','screenshot','--filename',str(ARTIFACTS/'anonymous-practice.png'))
    code('forged-cookie', '''
      await page.context().clearCookies();
      await page.context().addCookies([{name:'better-auth.session_token',value:'forged',url:base}]);return true;
    ''')
    matrix('forged-session')
    for session in ['a','b']:
        cli('console-'+session,'console',session=session)
        cli('requests-'+session,'requests',session=session)
    print(f'PASS private practice: {OUT / "practice-assertions.json"}',flush=True)
finally:
    for session in ['a','b']:
        cli('close-'+session,'close',session=session)
