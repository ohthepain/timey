import { githubFetch } from './github-http.mjs';
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { digest, requireThat, writeJson } from './common.mjs';
import { readProjectSettings } from './project-settings.mjs';
import { githubAppCredentials } from './github-app.mjs';
import { githubAppEnvironment, githubAppEnvironmentKeys } from './project-env.mjs';
import { sharedIssueQueueConfig, sharedIssueQueueEnabled } from './shared-issue-config.mjs';
import { issueStorageDirectory } from './issue-report-storage.mjs';

const run = promisify(execFile);
const ordinaryStorageFields = ['sharedIssueQueueDirect', 'sharedIssueQueueReviewRequired'];
const permissionsRequired = { contents: 'write', pull_requests: 'write' };
const policySource = fileURLToPath(new URL('./guard.mjs', import.meta.url));

function json(root, path) {
  if (!existsSync(join(root, path))) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch {
    throw Error(`Cannot read valid configuration from ${path}.`);
  }
  requireThat(Object.prototype.toString.call(value) === '[object Object]', `Use an object in ${path}.`);
  return value;
}

function privateKeyReference(config, file) {
  if (config.privateKey) return { name: file + '#privateKey', available: true, source: file };
  if (config.privateKeyPath)
    return { name: config.privateKeyPath, available: existsSync(config.privateKeyPath), source: file };
  return { name: file + '#privateKey', available: Boolean(config.privateKey), source: file };
}

function fileCredentialReferences(root) {
  const file = '.issues/github-app.json';
  const config = json(root, file);
  return [
    { name: file + '#appId', available: Boolean(config.appId), source: file },
    { name: file + '#installationId', available: Boolean(config.installationId), source: file },
    privateKeyReference(config, file),
  ];
}

function environmentCredentialReferences(environment) {
  return githubAppEnvironmentKeys.map((name) => ({
    name,
    available: Boolean(environment[name]),
    source: '.env or process environment',
  }));
}

function connectionView(root) {
  const { repository = null, remote = null, target = null } = json(root, '.issues/issue-delivery-config.json');
  const environment = githubAppEnvironment(root);
  const usesEnvironment = githubAppEnvironmentKeys.some((name) => environment[name]);
  const references = usesEnvironment ? environmentCredentialReferences(environment) : fileCredentialReferences(root);
  return {
    repository,
    remote,
    target,
    configured: usesEnvironment || existsSync(join(root, '.issues/github-app.json')),
    references,
    permissionsRequired,
  };
}

function lifecycleLabels(lifecycle) {
  return lifecycle.content
    .split('\n')
    .map((line) => line.split('|').map((part) => part.replaceAll('`', '').trim()))
    .filter((parts) => /^(custom|ready-for-|ready-to-|closed)/.test(parts[1] || '') && parts.length >= 6)
    .map((parts) => ({ role: parts[1], state: parts[2], next: parts[3], meaning: parts[4], source: lifecycle.path }));
}

function githubStorageView(root) {
  try {
    return configuredGithubStorage(root);
  } catch {
    return {
      provider: 'github',
      configuration: {},
      editableFields: [],
      status:
        'GitHub queue configuration is incomplete. Configure valid GitHub issue delivery and a dedicated queue branch before changing publication options.',
    };
  }
}

function configuredGithubStorage(root) {
  const shared = sharedIssueQueueConfig(root);
  return {
    provider: 'github',
    configuration: {
      repository: shared.repository,
      remote: shared.remote,
      branch: shared.target,
      sharedIssueQueueDirect: shared.direct,
      sharedIssueQueueReviewRequired: shared.requireReview,
    },
    editableFields: ordinaryStorageFields,
    status: 'GitHub queue configured. Use Test connection to check authentication and permissions.',
  };
}

function localStorageView() {
  return {
    provider: 'local',
    configuration: { directory: '.issues', closedDirectory: '.issues/closed', archiveDirectory: '.issues/archive' },
    editableFields: [],
    status: 'Project-local Markdown storage.',
  };
}

function storageView(root) {
  const config = json(root, 'factory.config.json');
  return {
    ...(sharedIssueQueueEnabled(root) ? githubStorageView(root) : localStorageView()),
    providers: ['local', 'github'],
    source: 'factory.config.json',
    revision: digest(JSON.stringify(config)),
    migration: 'Saving changes publication options only. It never migrates issue reports or switches providers.',
    restartRequired: sharedIssueQueueEnabled(root),
  };
}

export function readProjectSettingsOverview(service) {
  const settings = readProjectSettings(service.root);
  return {
    ...settings,
    humanInputSource: policySource,
    lifecycle: {
      ...settings.lifecycle,
      overridePath: settings.lifecycle.path,
      overrideExists: settings.lifecycle.present,
      effectiveSource: settings.lifecycle.present ? settings.lifecycle.path : '@timey/local-issues/triage-labels.md',
      labels: lifecycleLabels(settings.lifecycle).map((label) => ({
        ...label,
        source: settings.lifecycle.present ? label.source : '@timey/local-issues/triage-labels.md',
      })),
    },
    git: connectionView(service.root),
    storage: storageView(service.root),
  };
}

async function testGitConnection(root) {
  const view = connectionView(root);
  requireThat(view.repository, 'Configure a GitHub repository before testing its connection.');
  requireThat(/^[\w.-]+\/[\w.-]+$/.test(view.repository), 'Configure a valid GitHub owner/repository.');
  try {
    const credentials = githubAppCredentials(root, view.repository);
    requireThat(credentials, 'Configure GitHub App credentials before testing its connection.');
    const session = await credentials.session();
    const response = await githubFetch(view.repository, `https://api.github.com/repos/${view.repository}`, {
      headers: {
        Authorization: 'Bearer ' + session.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      return {
        authenticated: true,
        ok: false,
        message: `GitHub permission check failed (HTTP ${response.status}).`,
        permissions: null,
      };
    const permissions = Object.fromEntries(
      Object.keys(permissionsRequired).map((name) => [name, session.permissions[name] || 'none'])
    );
    const ok = Object.entries(permissionsRequired).every(
      ([name, required]) => permissions[name] === required || permissions[name] === 'admin'
    );
    return {
      authenticated: true,
      ok,
      permissions,
      message: ok
        ? 'Authentication and required GitHub App permissions passed.'
        : 'Authenticated. Required contents and pull request write permissions are missing.',
    };
  } catch {
    return {
      authenticated: false,
      ok: false,
      permissions: null,
      message: 'GitHub App authentication or permission check failed. Verify the configured references and connection.',
    };
  }
}

function testLocalStorage(root) {
  const directory = issueStorageDirectory(root, 'open');
  try {
    accessSync(directory, constants.R_OK | constants.W_OK);
    return {
      ok: true,
      authenticated: null,
      permissions: { read: true, write: true },
      message: 'Project issue directory is readable and writable. No reports were changed.',
    };
  } catch {
    return {
      ok: false,
      authenticated: null,
      permissions: { read: false, write: false },
      message: 'Project issue directory is unavailable or lacks read/write access.',
    };
  }
}

function saveStorage(service, input) {
  const view = storageView(service.root);
  requireThat(input.revision === view.revision, 'Storage configuration changed. Reopen Settings before saving.');
  requireThat(
    input.changes && typeof input.changes === 'object' && !Array.isArray(input.changes),
    'Supply ordinary storage settings.'
  );
  requireThat(
    Object.keys(input.changes).every((key) => view.editableFields.includes(key)),
    'Only supported publication options can be edited. Provider and secret references are read-only.'
  );
  requireThat(
    Object.values(input.changes).every((value) => typeof value === 'boolean'),
    'Publication options must be true or false.'
  );
  const config = json(service.root, 'factory.config.json');
  writeJson(join(service.root, 'factory.config.json'), { ...config, ...input.changes });
  return storageView(service.root);
}

async function openProjectSource(root, source) {
  const path = join(root, source);
  requireThat(
    lstatSync(path, { throwIfNoEntry: false })?.isFile(),
    'The configured project source file is unavailable.'
  );
  const project = realpathSync(root);
  const local = relative(project, realpathSync(path));
  requireThat(
    local && !local.startsWith('..' + sep) && local !== '..',
    'The source file must remain inside this project.'
  );
  return openSource(path);
}

async function openSource(path) {
  requireThat(process.platform === 'darwin', 'Open the source path in your file manager.');
  await run('/usr/bin/open', [path], { timeout: 5000 });
  return { opened: true };
}

export function changeProjectSettings(service, input) {
  service.ownServer();
  const actions = {
    'open-lifecycle': () => openProjectSource(service.root, '.issues/triage-labels.md'),
    'open-policy': () => openSource(policySource),
    'test-git': () => testGitConnection(service.root),
    'test-storage': () =>
      sharedIssueQueueEnabled(service.root) ? testGitConnection(service.root) : testLocalStorage(service.root),
    'save-storage': () => saveStorage(service, input),
  };
  requireThat(Object.hasOwn(actions, input.action), 'Choose a supported project Settings action.');
  return actions[input.action]();
}
