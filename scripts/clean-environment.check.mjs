import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  symlinkSync,
  renameSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnvironment } from './factory-ui/common.mjs';

function fixture(t, names = ['GIT_DIR', 'CUSTOM_GIT_LOCAL']) {
  const directory = mkdtempSync(join(tmpdir(), 'clean-environment-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const count = join(directory, 'calls');
  const fail = join(directory, 'fail');
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
[ "$1" = rev-parse ] && [ "$2" = --local-env-vars ] || exit 9
printf 'call\\n' >> '${count}'
[ ! -f '${fail}' ] || exit 7
printf '%s\\n' ${names.map((name) => `'${name}'`).join(' ')}
`,
    { mode: 0o700 }
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, bin, fail, calls: () => readFileSync(count, 'utf8').trim().split('\n').length };
}

function environment(t, changes) {
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('Git variable discovery is reused while each environment remains fresh and isolated', (t) => {
  const f = fixture(t);
  environment(t, {
    PATH: f.bin,
    GIT_DIR: 'private-repository',
    CUSTOM_GIT_LOCAL: 'private-local-value',
    GIT_CONFIG_KEY_0: 'private-key',
    GIT_CONFIG_VALUE_0: 'private-value',
    TIMEY_CLEAN_ENV_FIXTURE: 'first',
  });
  const first = cleanEnvironment();
  assert.equal(first.GIT_DIR, undefined);
  assert.equal(first.CUSTOM_GIT_LOCAL, undefined);
  assert.equal(first.GIT_CONFIG_KEY_0, undefined);
  assert.equal(first.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(first.TIMEY_CLEAN_ENV_FIXTURE, 'first');
  first.TIMEY_CLEAN_ENV_FIXTURE = 'caller mutation';
  process.env.TIMEY_CLEAN_ENV_FIXTURE = 'second';
  process.env.CUSTOM_GIT_LOCAL = 'new-private-value';
  const second = cleanEnvironment();
  assert.equal(second.TIMEY_CLEAN_ENV_FIXTURE, 'second');
  assert.equal(second.CUSTOM_GIT_LOCAL, undefined);
  assert.equal(process.env.CUSTOM_GIT_LOCAL, 'new-private-value');
  assert.equal(f.calls(), 1, 'Repeated filtering must not launch another discovery process.');
});

test('changing PATH rediscovers the selected Git executable', (t) => {
  const first = fixture(t, ['FIRST_GIT_LOCAL']);
  const second = fixture(t, ['SECOND_GIT_LOCAL']);
  environment(t, { PATH: first.bin, FIRST_GIT_LOCAL: 'first', SECOND_GIT_LOCAL: 'second' });
  assert.equal(cleanEnvironment().FIRST_GIT_LOCAL, undefined);
  process.env.PATH = second.bin;
  const changed = cleanEnvironment();
  assert.equal(changed.FIRST_GIT_LOCAL, 'first');
  assert.equal(changed.SECOND_GIT_LOCAL, undefined);
  assert.equal(first.calls(), 1);
  assert.equal(second.calls(), 1);
  process.env.PATH = first.bin;
  assert.equal(cleanEnvironment().FIRST_GIT_LOCAL, undefined);
  assert.equal(first.calls(), 2, 'Only the current executable selection is retained.');
});

test('relative PATH discovery follows the current working directory', (t) => {
  const first = fixture(t, ['FIRST_GIT_LOCAL']);
  const second = fixture(t, ['SECOND_GIT_LOCAL']);
  const previous = process.cwd();
  t.after(() => process.chdir(previous));
  environment(t, { PATH: 'bin', FIRST_GIT_LOCAL: 'first', SECOND_GIT_LOCAL: 'second' });
  process.chdir(first.directory);
  assert.equal(cleanEnvironment().FIRST_GIT_LOCAL, undefined);
  process.chdir(second.directory);
  const changed = cleanEnvironment();
  assert.equal(changed.FIRST_GIT_LOCAL, 'first');
  assert.equal(changed.SECOND_GIT_LOCAL, undefined);
  assert.equal(first.calls(), 1);
  assert.equal(second.calls(), 1);
});

test('failed Git variable discovery is retried without retaining a failed result', (t) => {
  const f = fixture(t);
  environment(t, { PATH: f.bin, CUSTOM_GIT_LOCAL: 'private-value' });
  writeFileSync(f.fail, 'fail');
  assert.throws(
    () => cleanEnvironment(),
    (error) => error.status === 7
  );
  rmSync(f.fail);
  assert.equal(cleanEnvironment().CUSTOM_GIT_LOCAL, undefined);
  assert.equal(cleanEnvironment().CUSTOM_GIT_LOCAL, undefined);
  assert.equal(f.calls(), 2);
});

test('an absent PATH uses the operating system default Git search', (t) => {
  environment(t, { PATH: process.env.PATH, GIT_DIR: 'not-a-repository' });
  delete process.env.PATH;
  assert.equal(cleanEnvironment().GIT_DIR, undefined);
  assert.equal(cleanEnvironment().GIT_DIR, undefined);
});

test('replacing Git at the same selected path refreshes discovered local names', (t) => {
  const f = fixture(t, ['FIRST_GIT_LOCAL']);
  environment(t, { PATH: f.bin, FIRST_GIT_LOCAL: 'first', OTHER_GIT_LOCAL: 'other' });
  assert.equal(cleanEnvironment().FIRST_GIT_LOCAL, undefined);
  const path = join(f.bin, 'git');
  const previous = statSync(path);
  writeFileSync(path, readFileSync(path, 'utf8').replace('FIRST_GIT_LOCAL', 'OTHER_GIT_LOCAL'));
  utimesSync(path, previous.atime, previous.mtime);
  const changed = cleanEnvironment();
  assert.equal(changed.FIRST_GIT_LOCAL, 'first');
  assert.equal(changed.OTHER_GIT_LOCAL, undefined);
  assert.equal(f.calls(), 2);
});

test('Git symlink replacement refreshes discovery with unchanged PATH', (t) => {
  const first = fixture(t, ['FIRST_GIT_LOCAL']);
  const other = fixture(t, ['OTHER_GIT_LOCAL']);
  const directory = mkdtempSync(join(tmpdir(), 'clean-git-link-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'git');
  symlinkSync(join(first.bin, 'git'), path);
  environment(t, { PATH: directory, FIRST_GIT_LOCAL: 'first', OTHER_GIT_LOCAL: 'other' });
  assert.equal(cleanEnvironment().FIRST_GIT_LOCAL, undefined);
  symlinkSync(join(other.bin, 'git'), path + '.next');
  renameSync(path + '.next', path);
  assert.equal(cleanEnvironment().OTHER_GIT_LOCAL, undefined);
  assert.equal(first.calls(), 1);
  assert.equal(other.calls(), 1);
});

test('an earlier unexecutable Git does not hide the selected executable generation', (t) => {
  const blocked = fixture(t, ['BLOCKED_GIT_LOCAL']);
  const selected = fixture(t, ['FIRST_GIT_LOCAL']);
  chmodSync(join(blocked.bin, 'git'), 0o600);
  environment(t, { PATH: blocked.bin + ':' + selected.bin, FIRST_GIT_LOCAL: 'first', OTHER_GIT_LOCAL: 'other' });
  assert.equal(cleanEnvironment().FIRST_GIT_LOCAL, undefined);
  const path = join(selected.bin, 'git');
  writeFileSync(path, readFileSync(path, 'utf8').replace('FIRST_GIT_LOCAL', 'OTHER_GIT_LOCAL'));
  assert.equal(cleanEnvironment().OTHER_GIT_LOCAL, undefined);
  assert.equal(selected.calls(), 2);
});
