import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { digest, requireThat } from '../common.mjs';
import { readProjectEnv } from '../project-env.mjs';
import { sharedIssueQueueConfig, sharedIssueQueueEnabled } from '../shared-issue-config.mjs';

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const role = z.enum(['issue', 'coordination', 'artifact']);
const rolesByKind = {
  files: ['issue', 'coordination', 'artifact'],
  git: ['issue', 'coordination', 'artifact'],
  postgres: ['issue', 'coordination', 'artifact'],
  dynamodb: ['issue', 'coordination'],
  s3: ['artifact'],
};
const base = {
  id: identity,
  label: z.string().trim().min(1).max(100),
  roles: z.array(role).min(1).optional(),
};
const fileFields = {
  ...base,
  directory: z.string().max(4096).optional(),
  remote: z
    .string()
    .regex(/^[\w.-]+$/)
    .optional(),
  branch: z
    .string()
    .regex(/^[\w./-]+$/)
    .optional(),
};
const storeSchema = z.discriminatedUnion('kind', [
  z.object({ ...fileFields, kind: z.literal('files') }).strict(),
  z.object({ ...fileFields, kind: z.literal('git') }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('postgres'),
      urlEnv: envName.default('FACTORY_ISSUES_DB_URL'),
      userEnv: envName.default('FACTORY_DB_USER'),
      passwordEnv: envName.default('FACTORY_DB_PASSWORD'),
      schema: z.literal('factory').default('factory'),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('dynamodb'),
      table: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),
      region: z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .optional(),
      regionEnv: envName.default('AWS_REGION'),
      endpoint: z.string().url().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('s3'),
      bucket: z.string().min(3).max(255).optional(),
      region: z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .optional(),
      bucketEnv: envName.default('FACTORY_ARTIFACTS_BUCKET'),
      regionEnv: envName.default('FACTORY_ARTIFACTS_BUCKET_REGION'),
      prefix: z.string().max(1024).optional(),
      endpoint: z.string().url().optional(),
    })
    .strict(),
]);
const legacyRegistrySchema = z
  .object({
    version: z.literal(1),
    projectId: identity,
    issueDefault: identity.default('files'),
    coordination: identity.default('files'),
    artifacts: identity.default('files'),
    stores: z.array(storeSchema).min(1).max(64),
  })
  .strict();
const profileSchema = z
  .object({
    id: identity,
    label: z.string().trim().min(1).max(100),
    issueStore: identity,
    artifactStore: identity,
    retired: z.boolean().default(false),
  })
  .strict();
const registrySchema = z
  .object({
    version: z.literal(2),
    projectId: identity,
    mode: z.enum(['local', 'remote']),
    profileDefault: identity,
    coordination: identity,
    artifacts: identity,
    profiles: z.array(profileSchema).min(1).max(256),
    stores: z.array(storeSchema).min(1).max(64),
  })
  .strict();
const localStore = { id: 'files', label: 'Local files', kind: 'files', roles: rolesByKind.files };
const registryPath = (root) => join(root, '.issues/stores.json');

function defaultFileStore(root) {
  if (!sharedIssueQueueEnabled(root)) return localStore;
  try {
    const shared = sharedIssueQueueConfig(root);
    return { ...localStore, label: 'Git', kind: 'git', remote: shared.remote, branch: shared.target };
  } catch {
    const factory = JSON.parse(readFileSync(join(root, 'factory.config.json'), 'utf8'));
    return {
      ...localStore,
      label: 'Git',
      kind: 'git',
      remote: 'origin',
      branch: factory.sharedIssueQueueBranch || 'issue-queue',
    };
  }
}

function repositoryIdentity(root) {
  try {
    const remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    const url = new URL(remote.replace(/^git@([^:]+):/, 'ssh://git@$1/'));
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

function projectIdentity(root, persist = false) {
  const repository = repositoryIdentity(root);
  if (repository) return 'project-' + digest(repository).slice(0, 24);
  const path = join(root, '.issues/store-project-id');
  if (existsSync(path)) return identity.parse(readFileSync(path, 'utf8').trim());
  const id = 'local-' + digest(resolve(root)).slice(0, 24);
  if (!persist) return id;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, id + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return identity.parse(readFileSync(path, 'utf8').trim());
}

export function upgradeStoreConfig(value) {
  if (value?.version !== 1) return value;
  const parsed = legacyRegistrySchema.safeParse(value);
  requireThat(parsed.success, 'The legacy store configuration is invalid. Repair it before migrating profiles.');
  const config = parsed.data;
  const stores = config.stores.map((store) => ({
    ...store,
    roles: store.roles || rolesByKind[store.kind],
    label: store.label === 'Files/Git' ? (store.kind === 'files' ? 'Local files' : 'Git') : store.label,
  }));
  const selected = [config.issueDefault, config.coordination, config.artifacts].map((id) => {
    const store = stores.find((entry) => entry.id === id);
    requireThat(store, 'The legacy selected storage destination is missing. Resolve it before migrating profiles.');
    return store.kind === 'files' ? 'local' : 'remote';
  });
  requireThat(
    new Set(selected).size === 1,
    'The legacy configuration mixes local and remote storage. Resolve its destinations before activating profiles.'
  );
  const mode = selected[0];
  return {
    version: 2,
    projectId: config.projectId,
    mode,
    profileDefault: config.issueDefault,
    coordination: config.coordination,
    artifacts: config.artifacts,
    profiles: stores
      .filter((store) => store.roles.includes('issue'))
      .map((store) => ({
        id: store.id,
        label: store.label,
        issueStore: store.id,
        artifactStore: config.artifacts,
        retired: (store.kind === 'files' ? 'local' : 'remote') !== mode,
      })),
    stores,
  };
}

function requireMode(config, store) {
  requireThat(
    (store.kind === 'files' ? 'local' : 'remote') === config.mode,
    'Choose storage destinations compatible with the project storage mode.'
  );
}

function normalizeRegistry(value) {
  const parsed = registrySchema.safeParse(upgradeStoreConfig(value));
  requireThat(
    parsed.success,
    'The store configuration is invalid. Review store IDs, roles, and connection references.'
  );
  const config = parsed.data;
  requireThat(
    new Set(config.stores.map(({ id }) => id)).size === config.stores.length,
    'Each configured store needs a unique ID.'
  );
  config.stores = config.stores.map((store) => {
    const supported = rolesByKind[store.kind];
    const roles = store.roles || supported;
    requireThat(
      roles.every((name) => supported.includes(name)),
      'This store type cannot serve the selected role.'
    );
    if (store.endpoint)
      requireThat(
        !new URL(store.endpoint).username && !new URL(store.endpoint).password,
        'Store endpoints must not contain credentials. Use environment references.'
      );
    return { ...store, roles: [...new Set(roles)] };
  });
  requireThat(
    new Set(config.profiles.map(({ id }) => id)).size === config.profiles.length,
    'Each storage profile needs a unique ID.'
  );
  requireMode(config, requireStore(config, config.coordination, 'coordination'));
  requireMode(config, requireStore(config, config.artifacts, 'artifact'));
  for (const profile of config.profiles) requireProfile(config, profile.id, { allowRetired: true });
  requireProfile(config, config.profileDefault);
  return config;
}

function readRegistryFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw Error('The store configuration cannot be read. Repair .issues/stores.json before continuing.');
  }
}

export function readStoreConfig(root, { persistIdentity = false } = {}) {
  const path = registryPath(root);
  const source = existsSync(path)
    ? readRegistryFile(path)
    : {
        version: 1,
        projectId: projectIdentity(root, persistIdentity),
        issueDefault: 'files',
        coordination: 'files',
        artifacts: 'files',
        stores: [defaultFileStore(root)],
      };
  const config = normalizeRegistry(source);
  return { ...config, revision: digest(JSON.stringify(config)) };
}

export function requireStore(config, storeId, selectedRole) {
  const store = config.stores.find(({ id }) => id === storeId);
  requireThat(store?.roles?.includes(selectedRole), `Choose a configured ${selectedRole} store.`);
  return store;
}

export function requireProfile(config, profileId, { allowRetired = false } = {}) {
  const profile = config.profiles.find(({ id }) => id === profileId);
  requireThat(profile, 'Choose a configured Issue storage profile.');
  requireThat(allowRetired || !profile.retired, 'Choose an active Issue storage profile.');
  const issue = requireStore(config, profile.issueStore, 'issue');
  const artifact = requireStore(config, profile.artifactStore, 'artifact');
  if (!profile.retired) {
    requireMode(config, issue);
    requireMode(config, artifact);
  }
  return profile;
}

export function storageProfileChoices(root) {
  const config = readStoreConfig(root);
  return config.profiles
    .filter(({ retired }) => !retired)
    .map(({ id, label, issueStore, artifactStore }) => ({
      value: id,
      label,
      issueStore,
      artifactStore,
    }));
}

function requireProjectMode(path, current, next) {
  if (!existsSync(path)) return;
  if (readRegistryFile(path).version !== 2) return;
  requireThat(
    next.mode === current.mode,
    'Changing project storage mode requires a project-wide migration and is not supported.'
  );
}

function requireProjectSelections(current, next, allowRoleChange) {
  requireThat(next.projectId === current.projectId, 'Keep the existing project identity when changing stores.');
  requireThat(
    allowRoleChange || (next.coordination === current.coordination && next.artifacts === current.artifacts),
    'Move project storage explicitly before changing Coordination or Artifact stores.'
  );
}

function connectionIdentity({ label: _label, ...fields }) {
  return JSON.stringify(fields);
}

function requireUnchangedDestinations(current, next) {
  for (const store of current.stores) {
    const destination = next.stores.find(({ id }) => id === store.id);
    requireThat(
      destination && connectionIdentity(store) === connectionIdentity(destination),
      'Keep existing store destinations and roles unchanged. Add a store and perform a checked move.'
    );
  }
}

function requireRetainedProfiles(current, next) {
  for (const profile of current.profiles)
    requireThat(
      next.profiles.some(({ id }) => id === profile.id),
      'Retire existing storage profiles instead of removing them.'
    );
}

export function writeStoreConfig(root, value, { expectedRevision, allowRoleChange = false } = {}) {
  const current = readStoreConfig(root, { persistIdentity: true });
  requireThat(expectedRevision === current.revision, 'The store configuration changed. Refresh before saving.');
  const next = normalizeRegistry(value);
  const path = registryPath(root);
  requireProjectMode(path, current, next);
  requireProjectSelections(current, next, allowRoleChange);
  requireUnchangedDestinations(current, next);
  requireRetainedProfiles(current, next);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
  return readStoreConfig(root);
}

function storeEnvironment(root) {
  return { ...readProjectEnv(root), ...process.env };
}

export function resolveStoreConnection(root, store) {
  const env = storeEnvironment(root);
  if (store.kind === 'postgres')
    return {
      connectionString: env[store.urlEnv],
      user: env[store.userEnv],
      password: env[store.passwordEnv],
      schema: store.schema,
    };
  if (store.kind === 's3')
    return {
      bucket: store.bucket || env[store.bucketEnv],
      region: store.region || env[store.regionEnv],
      prefix: store.prefix,
      endpoint: store.endpoint,
    };
  if (store.kind === 'dynamodb')
    return {
      table: store.table,
      region: store.region || env[store.regionEnv],
      endpoint: store.endpoint,
    };
  return { directory: store.directory, remote: store.remote, branch: store.branch };
}

export function safeStoreView(root) {
  const config = readStoreConfig(root);
  const env = storeEnvironment(root);
  return {
    ...config,
    stores: config.stores.map((store) => ({
      ...store,
      references: ['urlEnv', 'userEnv', 'passwordEnv', 'bucketEnv', 'regionEnv']
        .filter((key) => store[key])
        .map((key) => ({ name: store[key], available: Boolean(env[store[key]]), source: 'Project environment' })),
    })),
  };
}
