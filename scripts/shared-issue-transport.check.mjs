import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { git } from './factory-ui/common.mjs';
import { createSharedIssueTransport } from './factory-ui/shared-issue-transport.mjs';
import { createSharedIssueClaims } from './factory-ui/shared-issue-claims.mjs';
import { createSharedIssuePublication } from './factory-ui/shared-issue-publication.mjs';
import { createSharedIssueQueue } from './factory-ui/shared-issue-queue.mjs';
import { fetchSharedIssueTarget, syncSharedIssueFiles } from './factory-ui/shared-issue-sync.mjs';

const id = '20261111T165430736-ca3555165563420b';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'queue-transport-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'runner');
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'dev', remote);
  git(base, 'clone', '-q', remote, root);
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.test');
  mkdirSync(join(root, '.issues'));
  writeFileSync(join(root, '.issues', id + '.md'), '---\nstate: closed\n---\n\nSaved report.\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Seed queue');
  git(root, 'push', '-q', 'origin', 'dev');
  return { base, root, remote };
}

function fakeSSH(t, base, remote) {
  const bin = join(base, 'bin');
  const log = join(base, 'ssh.jsonl');
  mkdirSync(bin);
  const script = join(bin, 'ssh');
  writeFileSync(
    script,
    `#!${process.execPath}
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const socket = args.find(value => value.startsWith('ControlPath='))?.slice(12);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, socket }) + '\\n');
if (args.includes('-O')) { if (socket && existsSync(socket)) unlinkSync(socket); process.exit(0); }
if (socket) writeFileSync(socket, 'private test connection');
const program = args.at(-1)?.startsWith('git-receive-pack') ? 'git-receive-pack' : 'git-upload-pack';
const result = spawnSync(program, [${JSON.stringify(remote)}], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`
  );
  chmodSync(script, 0o755);
  const previous = process.env.PATH;
  const sshEnvironment = new Map(
    ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT'].map((key) => [key, process.env[key]])
  );
  for (const key of sshEnvironment.keys()) delete process.env[key];
  process.env.PATH = bin + ':' + previous;
  t.after(() => (process.env.PATH = previous));
  t.after(() => {
    for (const [key, value] of sshEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
}

test('queue Git operations share a private SSH connection and close only their owned session', async (t) => {
  const { base, root, remote } = fixture(t);
  const events = fakeSSH(t, base, remote);
  git(root, 'remote', 'set-url', 'origin', 'git@github.com:example/timey.git');
  const transport = createSharedIssueTransport(root, 'origin');
  const sibling = createSharedIssueTransport(root, 'origin');
  t.after(() => transport.close());
  t.after(() => sibling.close());
  const environment = transport.environment();
  const socket = environment.GIT_SSH_COMMAND.match(/ControlPath=(\S+)/)[1];
  const siblingSocket = sibling.environment().GIT_SSH_COMMAND.match(/ControlPath=(\S+)/)[1];
  assert.notEqual(socket, siblingSocket);
  assert.equal(statSync(dirname(socket)).mode & 0o777, 0o700);
  assert.equal(process.env.GIT_SSH_COMMAND, undefined);
  const claims = createSharedIssueClaims({ root, transport });
  const claim = claims.acquire(id);
  assert.equal((await claims.listAsync()).get(id).oid, claim.oid);
  const publication = createSharedIssuePublication({
    root,
    remote: 'origin',
    target: 'dev',
    repository: 'example/timey',
    transport,
  });
  assert.match(publication.readTarget(id).report, /Saved report/);
  const revision = await fetchSharedIssueTarget(root, {
    remote: 'origin',
    target: 'dev',
    transport,
  });
  assert.equal(revision, git(root, 'rev-parse', 'HEAD'));
  syncSharedIssueFiles(
    root,
    { remote: 'origin', target: 'dev', transport },
    join(root, '.issues/sync.json'),
    () => false
  );
  assert.equal(claims.release(claim), true);
  execFileSync('git', ['-C', root, 'ls-remote', 'origin', 'refs/heads/dev'], {
    env: { ...process.env, ...sibling.environment() },
  });
  const commands = events().filter((event) => !event.args.includes('-O'));
  assert.ok(commands.length >= 6);
  assert.ok(commands.every((event) => [socket, siblingSocket].includes(event.socket)));
  assert.ok(
    commands.every((event) => event.args.includes('ControlMaster=auto') && event.args.includes('ControlPersist=60'))
  );
  transport.close();
  transport.close();
  assert.deepEqual(transport.environment(), {});
  assert.equal(existsSync(dirname(socket)), false);
  assert.equal(existsSync(siblingSocket), true);
  assert.ok(events().find((event) => event.args.includes('-O') && event.socket === socket));
});

test('queue transport preserves custom SSH commands and non-SSH remotes', (t) => {
  const { root } = fixture(t);
  const local = createSharedIssueTransport(root, 'origin');
  assert.deepEqual(local.environment(), {});
  local.close();
  const missing = createSharedIssueTransport(root, 'missing');
  assert.deepEqual(missing.environment(), {});
  missing.close();
  git(root, 'remote', 'set-url', 'origin', 'git@github.com:example/timey.git');
  for (const key of ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT']) {
    const previous = process.env[key];
    process.env[key] = 'custom-transport';
    try {
      const transport = createSharedIssueTransport(root, 'origin');
      assert.deepEqual(transport.environment(), {});
      transport.close();
      assert.equal(process.env[key], 'custom-transport');
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
  git(root, 'config', 'core.sshCommand', 'custom-ssh');
  const configured = createSharedIssueTransport(root, 'origin');
  assert.deepEqual(configured.environment(), {});
  configured.close();
  assert.equal(git(root, 'config', '--get', 'core.sshCommand'), 'custom-ssh');
  git(root, 'config', '--unset', 'core.sshCommand');
  git(root, 'config', 'ssh.variant', 'plink');
  const variant = createSharedIssueTransport(root, 'origin');
  assert.deepEqual(variant.environment(), {});
  variant.close();
  assert.equal(git(root, 'config', '--get', 'ssh.variant'), 'plink');
});

test('closing the shared queue removes its private transport', (t) => {
  const { base, root, remote } = fixture(t);
  const events = fakeSSH(t, base, remote);
  git(root, 'remote', 'set-url', 'origin', 'git@github.com:example/timey.git');
  writeFileSync(join(root, 'factory.config.json'), JSON.stringify({ sharedIssueQueue: true }));
  writeFileSync(
    join(root, '.issues/issue-delivery-config.json'),
    JSON.stringify({
      provider: 'github',
      repository: 'example/timey',
      remote: 'origin',
      target: 'dev',
    })
  );
  const service = {
    root,
    lifecycleTasks: new Map(),
    issueChats: { tasks: new Map() },
    store: { runs: [], connected: new Set() },
  };
  const queue = createSharedIssueQueue(service);
  queue.refresh(true);
  const socket = events().find((event) => event.socket)?.socket;
  assert.ok(socket);
  queue.close();
  assert.equal(existsSync(dirname(socket)), false);
});
