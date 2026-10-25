"""Real application HTTP/PostgreSQL proof. Only creates a uniquely owned temporary cluster."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sys
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(tempfile.mkdtemp(prefix="timey-auth-foundation-", dir="/private/tmp"))
COMMANDS = []
ASSERTIONS = {}
HTTP_EVIDENCE = []


def run(label, args, env=None, expected=0):
    result = subprocess.run(args, cwd=ROOT, env={**os.environ, **(env or {})},
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log = OUT / (label + ".log")
    log.write_text(result.stdout)
    COMMANDS.append({"command": args, "exit": result.returncode, "log": str(log)})
    (OUT / "commands.json").write_text(json.dumps(COMMANDS, indent=2) + "\n")
    if expected == 0 and result.returncode != 0:
        raise RuntimeError(f"{label} exited {result.returncode}: {log}")
    if expected != 0 and result.returncode == 0:
        raise AssertionError(f"{label} unexpectedly succeeded")
    return result.stdout


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


PG_PORT = port()
APP_PORT = port()
SMTP_PORT = port()
BASE = f"http://127.0.0.1:{APP_PORT}"
ADMIN_URL = f"postgresql://fixture@127.0.0.1:{PG_PORT}/"


def sql(label, statement, database="foundation"):
    return run(label, ["psql", ADMIN_URL + database, "-v", "ON_ERROR_STOP=1", "-Atc", statement]).strip()


def owner_env(database):
    return {
        "AUTH_DATABASE_URL": ADMIN_URL.replace("fixture@", "auth_owner@") + database,
        "DATABASE_URL": ADMIN_URL.replace("fixture@", "domain_owner@") + database + "?schema=domain",
    }


def snapshot(label, database, schema):
    dump = run(label, ["pg_dump", ADMIN_URL + database, "--schema=" + schema,
                       "--no-owner", "--no-privileges"])
    # PostgreSQL versions with dump restriction keys randomize these two lines.
    stable = "\n".join(line for line in dump.splitlines()
                       if not line.startswith(("\\restrict ", "\\unrestrict ")))
    return hashlib.sha256(stable.encode()).hexdigest()


def http(method, path, cookie="", body=None, origin=None):
    headers = {"Origin": origin or BASE}
    if cookie:
        headers["Cookie"] = cookie
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(BASE + path, headers=headers, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read().decode()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = raw
    cookies = http_cookies(response.headers.get_all("Set-Cookie") or [])
    HTTP_EVIDENCE.append({"method": method, "path": path, "status": response.status,
                          "body": data, "headers": dict(response.headers), "request_cookie": cookie})
    (OUT / "http-evidence.json").write_text(json.dumps(HTTP_EVIDENCE, indent=2) + "\n")
    return response.status, data, cookies, dict(response.headers)


from http import cookies as cookie_module


def http_cookies(values):
    jar = cookie_module.SimpleCookie()
    for value in values:
        jar.load(value)
    return "; ".join(f"{key}={value.value}" for key, value in jar.items())


def expect(label, actual, expected):
    assert actual == expected, f"{label}: {actual!r} != {expected!r}"
    ASSERTIONS[label] = True
    (OUT / "assertions.json").write_text(json.dumps(ASSERTIONS, indent=2) + "\n")


def signup(username):
    status, data, cookie, headers = http("POST", "/api/auth/sign-up/email", body={
        "username": username, "name": username, "email": username + "@example.test",
        "password": "Disposable-fixture-password-123!"})
    expect(username + " signup", status, 200)
    assert cookie and "set-cookie" in {key.lower() for key in headers}
    return data["user"]["id"], cookie


def check_migrations():
    for database in ["foundation", "replay", "shadow"]:
        sql("create-" + database, "CREATE DATABASE " + database, "postgres")
        sql("schemas-" + database,
            "REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
            "CREATE SCHEMA auth AUTHORIZATION auth_owner;"
            "CREATE SCHEMA auth_migrations AUTHORIZATION auth_owner;"
            "CREATE SCHEMA domain AUTHORIZATION domain_owner;"
            f"GRANT CREATE ON DATABASE {database} TO auth_owner, domain_owner;", database)
        env = owner_env(database)
        run("auth-migrate-" + database, ["npm", "run", "auth:migrate"], env)
        auth_before = snapshot("auth-before-prisma-" + database, database, "auth")
        history_before = snapshot("history-before-prisma-" + database, database, "auth_migrations")
        run("domain-migrate-" + database, ["npm", "exec", "--no", "--", "prisma", "migrate", "deploy"], env)
        expect(database + " Prisma preserves auth", snapshot("auth-after-prisma-" + database, database, "auth"), auth_before)
        expect(database + " Prisma preserves auth history", snapshot("history-after-prisma-" + database, database, "auth_migrations"), history_before)
        before = snapshot("domain-before-drizzle-" + database, database, "domain")
        run("auth-migrate-repeat-" + database, ["npm", "run", "auth:migrate"], env)
        expect(database + " Drizzle preserves domain and history", snapshot("domain-after-drizzle-" + database, database, "domain"), before)
    for schema in ["auth", "auth_migrations"]:
        first = snapshot("shadow-before-" + schema, "shadow", schema)
        run("shadow-diff-" + schema, ["npm", "exec", "--no", "--", "prisma", "migrate", "diff",
             "--from-migrations", "prisma/migrations", "--to-schema-datamodel", "prisma/schema.prisma",
             "--shadow-database-url", owner_env("shadow")["DATABASE_URL"]], owner_env("foundation"))
        expect("shadow preserves " + schema, snapshot("shadow-after-" + schema, "shadow", schema), first)
    for role, schema in [("auth_owner", "domain"), ("domain_owner", "auth")]:
        run("denied-" + role, ["psql", ADMIN_URL.replace("fixture@", role + "@") + "foundation",
             "-v", "ON_ERROR_STOP=1", "-c", f'DELETE FROM {schema}."' + ("User" if schema == "domain" else "user") + '";'], expected=1)
    for query, label in [
        ('SELECT hash,name,created_at FROM auth_migrations.__drizzle_migrations ORDER BY id', "auth-history"),
        ('SELECT migration_name,checksum FROM domain._prisma_migrations ORDER BY migration_name', "domain-history"),
    ]:
        expect("fresh replay " + label, sql("replay-" + label, query, "replay"), sql("initial-" + label, query))


def check_http():
    expect("missing session", http("GET", "/api/session")[0], 401)
    expect("forged session", http("GET", "/api/session", "better-auth.session_token=forged")[0], 401)
    expect("foreign origin rejected", http("POST", "/api/auth/sign-up/email", body={
        "username": "foreign", "name": "foreign", "email": "foreign@example.test",
        "password": "Disposable-fixture-password-123!"}, origin="https://other.example.test")[0], 403)
    user_id, cookie = signup("stablefixture")
    expect("session persisted", sql("persisted", 'SELECT count(*) FROM auth.session'), "1")
    expect("profile lazy", sql("lazy", 'SELECT count(*) FROM domain."User"'), "0")
    sql("slow-provision", '''CREATE FUNCTION domain.slow_profile() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$;
        CREATE TRIGGER slow_profile BEFORE INSERT ON domain."User" FOR EACH ROW EXECUTE FUNCTION domain.slow_profile();''')
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: http("GET", "/api/session", cookie), range(8)))
    expect("concurrent provisioning", [result[0] for result in results], [200] * 8)
    expect("trusted stable IDs", [result[1]["userId"] for result in results], [user_id] * 8)
    expect("private response uncached", results[0][3].get("cache-control", results[0][3].get("Cache-Control")), "no-store")
    expect("one profile without Keycloak mapping", sql("one-profile", 'SELECT count(*) FROM domain."User" WHERE "keycloakId" IS NULL'), "1")
    sql("remove-slow", 'DROP TRIGGER slow_profile ON domain."User"; DROP FUNCTION domain.slow_profile();')
    escaped_id = user_id.replace("'", "''")
    sql("domain-state", f'''INSERT INTO domain."Method" (id,title,index,"authorId","modifiedAt")
        VALUES ('fixture-method','Fixture method',0,'{escaped_id}',now());
        INSERT INTO domain."Module" (id,title,index,"authorId","methodId","modifiedAt")
        VALUES ('fixture-module','Fixture module',0,'{escaped_id}','fixture-method',now());
        UPDATE domain."User" SET "currentModuleId"='fixture-module' WHERE id='{escaped_id}';''')
    sql("profile-state", 'UPDATE domain."User" SET "userName"=\'preserved-domain-state\';')
    expect("repeat identity", http("GET", "/api/session", cookie)[1]["userId"], user_id)
    expect("domain state preserved", sql("preserved-state", 'SELECT "userName" FROM domain."User"'), "preserved-domain-state")
    expect("current module preserved", sql("preserved-module", 'SELECT "currentModuleId" FROM domain."User"'), "fixture-module")
    auth_before = snapshot("live-auth-before-prisma", "foundation", "auth")
    history_before = snapshot("live-history-before-prisma", "foundation", "auth_migrations")
    run("live-prisma-replay", ["npm", "exec", "--no", "--", "prisma", "migrate", "deploy"], owner_env("foundation"))
    expect("live auth persistence", snapshot("live-auth-after-prisma", "foundation", "auth"), auth_before)
    expect("live auth history persistence", snapshot("live-history-after-prisma", "foundation", "auth_migrations"), history_before)
    domain_before = snapshot("live-domain-before-drizzle", "foundation", "domain")
    run("live-auth-replay", ["npm", "run", "auth:migrate"], owner_env("foundation"))
    expect("live domain and history preserved", snapshot("live-domain-after-drizzle", "foundation", "domain"), domain_before)
    expect("cookie after migration replay", http("GET", "/api/session", cookie)[1]["userId"], user_id)
    sql("expire", "UPDATE auth.session SET expires_at=now()-interval '1 day'")
    expect("expired session", http("GET", "/api/session", cookie)[0], 401)
    status, _, cookie, _ = http("POST", "/api/auth/sign-in/username", body={
        "username": "stablefixture", "password": "Disposable-fixture-password-123!", "rememberMe": False})
    expect("username login", status, 200)
    expect("login retains profile ID", http("GET", "/api/session", cookie)[1]["userId"], user_id)
    sql("revoke", "DELETE FROM auth.session")
    expect("revoked session", http("GET", "/api/session", cookie)[0], 401)
    status, _, cookie, _ = http("POST", "/api/auth/sign-in/email", body={
        "email": "stablefixture@example.test", "password": "Disposable-fixture-password-123!"})
    expect("email login", status, 200)
    expect("logout", http("POST", "/api/auth/sign-out", cookie, {})[0], 200)
    expect("logged out cookie rejected", http("GET", "/api/session", cookie)[0], 401)
    retry_id, retry_cookie = signup("retryfixture")
    sql("fail-provision", '''CREATE FUNCTION domain.fail_profile() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'deliberate fixture provisioning failure'; END $$;
        CREATE TRIGGER fail_profile BEFORE INSERT ON domain."User" FOR EACH ROW EXECUTE FUNCTION domain.fail_profile();''')
    expect("failure blocks domain response", http("GET", "/api/session", retry_cookie)[0], 503)
    expect("auth remains recoverable", http("GET", "/api/auth/get-session", retry_cookie)[1]["user"]["id"], retry_id)
    expect("failed profile absent", sql("failed-absent", 'SELECT count(*) FROM domain."User"'), "1")
    sql("remove-failure", 'DROP TRIGGER fail_profile ON domain."User"; DROP FUNCTION domain.fail_profile();')
    expect("retry same trusted ID", http("GET", "/api/session", retry_cookie)[1]["userId"], retry_id)
    # Same email must never attach a new trusted identity to a legacy local ID.
    collision_id, collision_cookie = signup("collisionfixture")
    sql("legacy-collision", '''INSERT INTO domain."User" (id,"keycloakId","userName",email,"modifiedAt")
        VALUES ('legacy-id','legacy-keycloak','legacy','collisionfixture@example.test',now())''')
    expect("email collision fails closed", http("GET", "/api/session", collision_cookie)[0], 503)
    sql("remove-fixture-collision", 'DELETE FROM domain."User" WHERE id=\'legacy-id\'')
    expect("collision retry", http("GET", "/api/session", collision_cookie)[1]["userId"], collision_id)
    (OUT / "identities.json").write_text(json.dumps({"stable": user_id, "retry": retry_id, "collision": collision_id}, indent=2))

    return retry_id, retry_cookie


def stop_application(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
    COMMANDS.append({"operation": "stop application process group", "pid": process.pid,
                     "exit": process.returncode})


app = None
mail = None
started = False
print(f"Authentication fixture evidence: {OUT}", flush=True)
try:
    run("initdb", ["initdb", "-D", str(OUT / "pgdata"), "-A", "trust", "-U", "fixture"])
    run("pg-start", ["pg_ctl", "-D", str(OUT / "pgdata"), "-l", str(OUT / "postgres.log"),
                     "-o", f"-h 127.0.0.1 -p {PG_PORT} -k {OUT}", "-w", "start"])
    started = True
    sql("fixture-roles", "CREATE ROLE auth_owner LOGIN; CREATE ROLE domain_owner LOGIN;", "postgres")
    if any(flag in sys.argv for flag in ['--practice', '--content', '--beats', '--edit-beats']):
        sql('create-practice', 'CREATE DATABASE foundation', 'postgres')
        sql('practice-schemas', 'CREATE SCHEMA auth AUTHORIZATION auth_owner; CREATE SCHEMA auth_migrations AUTHORIZATION auth_owner; CREATE SCHEMA domain AUTHORIZATION domain_owner; GRANT CREATE ON DATABASE foundation TO auth_owner, domain_owner;')
        run('practice-auth-migrate', ['npm', 'run', 'auth:migrate'], owner_env('foundation'))
        run('practice-domain-migrate', ['npm', 'exec', '--no', '--', 'prisma', 'migrate', 'deploy'], owner_env('foundation'))
    else:
        check_migrations()
    run("prisma-generate", ["npm", "exec", "--no", "--", "prisma", "generate"])
    mail_log = (OUT / "smtp.log").open("w")
    mail = subprocess.Popen(["node", "scripts/auth-mail-capture.mjs", str(SMTP_PORT), str(OUT)],
                            cwd=ROOT, stdout=mail_log, stderr=subprocess.STDOUT, start_new_session=True)
    COMMANDS.append({"command": ["node", "scripts/auth-mail-capture.mjs", str(SMTP_PORT), str(OUT)],
                     "pid": mail.pid, "log": str(OUT / "smtp.log")})
    env = {**os.environ, **owner_env("foundation"), "BETTER_AUTH_URL": BASE,
           "SMTP_HOST": "127.0.0.1", "SMTP_PORT": str(SMTP_PORT),
           "SMTP_FROM": "timey@example.test", "SMTP_SECURE": "false",
           "BETTER_AUTH_SECRET": "unique-disposable-foundation-secret-" + OUT.name, "HOST": "127.0.0.1"}
    # Capture is unauthenticated loopback; never inherit deployment credentials.
    env.pop("SMTP_USER", None)
    env.pop("SMTP_PASSWORD", None)
    (OUT / "browser-target.json").write_text(json.dumps({"base": BASE, "database": ADMIN_URL + "foundation"}))
    app_log = (OUT / "application.log").open("w")
    app = subprocess.Popen(["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(APP_PORT)],
                           cwd=ROOT, env=env, stdout=app_log, stderr=subprocess.STDOUT, start_new_session=True)
    COMMANDS.append({"command": ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(APP_PORT)],
                     "log": str(OUT / "application.log"), "pid": app.pid})
    for attempt in range(90):
        if app.poll() is not None:
            raise RuntimeError("Application stopped; inspect application.log")
        try:
            if http("GET", "/api/session")[0] == 401:
                break
        except (OSError, TimeoutError):
            pass
        time.sleep(1)
    else:
        raise RuntimeError("Application not ready; inspect application.log")
    if '--edit-beats' in sys.argv:
        run('beat-edit-browser', ['python3', 'scripts/beat-edit-browser.py', str(OUT)])
    elif '--beats' in sys.argv:
        run('beat-browser', ['python3', 'scripts/beat-browser.py', str(OUT)])
    elif '--content' in sys.argv:
        run('content-browser', ['python3', 'scripts/content-browser.py', str(OUT)])
    elif '--practice' in sys.argv:
        run('practice-browser', ['python3', 'scripts/practice-browser.py', str(OUT)])
    else:
        retry_id, retry_cookie = check_http()
        stop_application(app)
        app = subprocess.Popen(["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(APP_PORT)],
                               cwd=ROOT, env=env, stdout=app_log, stderr=subprocess.STDOUT, start_new_session=True)
        COMMANDS.append({"operation": "restart application", "pid": app.pid, "log": str(OUT / "application.log")})
        for attempt in range(90):
            if app.poll() is not None:
                raise RuntimeError("Restarted application stopped; inspect application.log")
            try:
                response = http("GET", "/api/session", retry_cookie)
                if response[0] == 200:
                    expect("persisted session after app restart", response[1]["userId"], retry_id)
                    break
            except (OSError, TimeoutError):
                pass
            time.sleep(1)
        else:
            raise RuntimeError("Restarted application not ready")
        print(f"PASS: {len(ASSERTIONS)} assertions; evidence: {OUT}", flush=True)
    if '--browser' in sys.argv:
        run("browser", ["python3", "scripts/auth-browser.py", str(OUT)])
    if '--pause-for-browser' in sys.argv:
        input(f"Browser fixture ready at {BASE}; press Enter to stop its processes: ")
finally:
    if app:
        stop_application(app)
        app_log.close()
    if started:
        run("pg-stop", ["pg_ctl", "-D", str(OUT / "pgdata"), "-m", "fast", "-w", "stop"])
    if mail:
        stop_application(mail)
        mail_log.close()
