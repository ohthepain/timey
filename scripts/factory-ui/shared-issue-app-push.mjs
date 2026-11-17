import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cleanEnvironment, requireThat } from './common.mjs';
import { githubAppCredentials } from './github-app.mjs';

// This process bridges the synchronous queue publisher and async App authentication.
const { repository, targetRef, commit } = JSON.parse(readFileSync(0, 'utf8'));
requireThat(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid repository.');
requireThat(typeof commit === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit), 'Invalid commit.');
requireThat(
  typeof targetRef === 'string' && /^refs\/heads\/[a-zA-Z0-9][\w./-]*$/.test(targetRef),
  'Invalid queue ref.'
);
const url = `https://github.com/${repository}.git`;
const remote = 'timey-queue-app';
const env = cleanEnvironment();
for (const key of Object.keys(env)) {
  if (/^(?:GIT_TRACE|GIT_CURL_VERBOSE$|TIMEY_SOFTWARE_FACTORY_GITHUB_|GH_TOKEN$|GITHUB_TOKEN$)/.test(key))
    delete env[key];
}
const git = (args, authentication = {}) =>
  execFileSync('git', ['-c', `remote.${remote}.url=${url}`, '-c', `remote.${remote}.pushurl=${url}`, ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https', ...authentication },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();

git(['check-ref-format', targetRef]);
const pushUrls = git(['remote', '-v'])
  .split('\n')
  .filter((line) => line.startsWith(`${remote}\t`) && line.endsWith(' (push)'));
requireThat(pushUrls.length === 1 && pushUrls[0] === `${remote}\t${url} (push)`, 'Unexpected App push URL.');

let session;
try {
  const credentials = githubAppCredentials(process.cwd(), repository);
  requireThat(credentials, 'Missing GitHub App configuration.');
  session = await credentials.session();
} catch {
  process.exit(2);
}

const authorization = Buffer.from(`x-access-token:${session.token}`).toString('base64');
try {
  git(
    [
      '-c',
      'credential.helper=',
      '-c',
      'http.followRedirects=false',
      '--config-env',
      `http.${url}.extraHeader=TIMEY_QUEUE_GIT_AUTHORIZATION`,
      'push',
      '--no-mirror',
      '--no-verify',
      '--no-follow-tags',
      '--recurse-submodules=no',
      remote,
      `${commit}:${targetRef}`,
    ],
    { TIMEY_QUEUE_GIT_AUTHORIZATION: `Authorization: Basic ${authorization}` }
  );
} catch {
  // Git errors may contain authentication details. Report only the failed stage.
  process.exitCode = 3;
}
