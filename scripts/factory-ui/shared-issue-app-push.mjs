import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cleanEnvironment, requireThat } from './common.mjs';
import { githubAppCredentials } from './github-app.mjs';
import { readQueueClaim } from './shared-issue-paths.mjs';
import { sharedIssueQueueConfig, queueMetadataPath } from './shared-issue-config.mjs';

// This process bridges the synchronous queue publisher and async App authentication.
const { repository, targetRef, commit, releaseClaim, expectedHead } = JSON.parse(readFileSync(0, 'utf8'));
requireThat(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid repository.');
requireThat(typeof commit === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit), 'Invalid commit.');
requireThat(
  typeof targetRef === 'string' && /^refs\/heads\/[a-zA-Z0-9][\w./-]*$/.test(targetRef),
  'Invalid queue ref.'
);
requireThat(
  typeof expectedHead === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedHead),
  'A queue push requires its expected head.'
);
const config = sharedIssueQueueConfig(process.cwd());
requireThat(
  config && targetRef === `refs/heads/${config.target}` && config.repository === repository,
  'Only the configured dedicated issue queue can receive automatic metadata commits.'
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
requireThat(
  git(['rev-parse', `${commit}^`]) === expectedHead,
  'The queue commit must directly extend its expected head.'
);
const paths = git(['diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', expectedHead, commit]).split(
  '\n'
);
requireThat(paths.length > 0 && paths.every(queueMetadataPath), 'Queue writes may only change issue metadata.');
for (const path of paths) {
  const entry = git(['ls-tree', commit, '--', path]);
  requireThat(!entry || entry.startsWith('100644 blob '), 'Queue metadata must be regular files.');
}
if (releaseClaim) {
  requireThat(
    readQueueClaim(git, expectedHead, releaseClaim.issueId)?.oid === releaseClaim.oid &&
      readQueueClaim(git, commit, releaseClaim.issueId) === null,
    'The queue commit must release its exact owned claim.'
  );
}
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
      `--force-with-lease=${targetRef}:${expectedHead}`,
      remote,
      `${commit}:${targetRef}`,
    ],
    { TIMEY_QUEUE_GIT_AUTHORIZATION: `Authorization: Basic ${authorization}` }
  );
  process.stdout.write(
    JSON.stringify({
      commit,
      ...(releaseClaim && { releasedClaim: { issueId: releaseClaim.issueId, oid: releaseClaim.oid } }),
    })
  );
} catch {
  // Git errors may contain authentication details. Report only the failed stage.
  process.exitCode = 3;
}
