import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { assertStoreState, sealCoordination, inputDigest } from './coordination.mjs';
import { readStoreConfig, writeStoreConfig, requireStore } from './config.mjs';

function validateCatalog(config, catalogs, artifactStoreId) {
  for (const { value } of catalogs) {
    if (value.state === 'deleted') continue;
    assertStoreState(
      value.state === 'active',
      'STORE_BUSY',
      'Reconcile issue storage operations before activating profiles.'
    );
    const stores = [
      requireStore(config, value.storeId, 'issue'),
      requireStore(config, value.artifactStoreId || artifactStoreId, 'artifact'),
    ];
    assertStoreState(
      stores.every((store) => (store.kind === 'files') === (config.mode === 'local')),
      'STORE_MODE_MISMATCH',
      'Existing issue storage conflicts with the project mode. Resolve it before activating profiles.'
    );
  }
}

function attachedChildren(issue) {
  const header = issue.report.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const metadata = parse(header) || {};
  return attachedGroup(metadata).filter((child) => !child.detachedAt);
}
function attachedGroup(metadata) {
  return metadata.issue_group?.children || [];
}
function effectiveHome(issue, artifactStoreId) {
  return { storeId: issue.storeId, artifactStoreId: issue.artifactStoreId || artifactStoreId };
}
function validateChild(issue, child, artifactStoreId) {
  assertStoreState(child, 'STORE_GROUP_MISMATCH', 'Resolve missing sub-issues before activating profiles.');
  assertStoreState(
    inputDigest(effectiveHome(child, artifactStoreId)) === inputDigest(effectiveHome(issue, artifactStoreId)),
    'STORE_GROUP_MISMATCH',
    'Resolve master and sub-issue storage differences before activating profiles.'
  );
}
async function validateGroups(project, artifactStoreId) {
  const issues = await project.listIssues();
  const homes = new Map(issues.map((issue) => [issue.id, issue]));
  for (const issue of issues)
    for (const child of attachedChildren(issue)) validateChild(issue, homes.get(child.id), artifactStoreId);
}
async function backfillCatalogs(project, catalogs, artifactStoreId, seal, operationId) {
  for (const record of catalogs.filter((record) => record.value.state !== 'deleted' && !record.value.artifactStoreId)) {
    await project.coordination.commit(
      operationId + '/catalog/' + record.value.id,
      [{ key: record.key, revision: record.revision }],
      [{ key: record.key, value: { ...record.value, artifactStoreId } }],
      seal.token
    );
  }
}

export async function activateStorageProfiles(project, config) {
  const marker = 'project/storage-profiles';
  if (await project.records.get(marker)) return;
  const operationId = 'activate-storage-profiles-v2';
  const existing = await project.records.get('operations/' + encodeURIComponent(operationId));
  const artifactStoreId = existing?.value.input.artifactStoreId || config.artifacts;
  validateCatalog(config, await project.records.list('catalog/'), artifactStoreId);
  await validateGroups(project, artifactStoreId);
  const operation = await project.coordination.operation(operationId, 'activate-storage-profiles', { artifactStoreId });
  const seal = await sealCoordination(project.coordination, {
    id: operation.value.token,
    role: 'profiles',
    storeId: artifactStoreId,
    operationId,
  });
  const catalogs = await project.records.list('catalog/');
  validateCatalog(config, catalogs, artifactStoreId);
  await validateGroups(project, artifactStoreId);
  await backfillCatalogs(project, catalogs, artifactStoreId, seal, operationId);
  const gate = await project.records.get('project/migration');
  const current = await project.records.get(operation.key);
  await project.coordination.commit(
    operationId + '/confirmed',
    [
      { key: marker, revision: null },
      { key: gate.key, revision: gate.revision },
      { key: current.key, revision: current.revision },
    ],
    [
      { key: marker, value: { version: 2, initialArtifactStoreId: artifactStoreId } },
      { key: gate.key, value: null },
      { key: current.key, value: { ...current.value, status: 'confirmed', confirmedAt: new Date().toISOString() } },
    ],
    seal.token
  );
}

export function persistStorageProfiles(root) {
  const path = join(root, '.issues/stores.json');
  if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).version === 2) return;
  const { revision, ...config } = readStoreConfig(root);
  writeStoreConfig(root, config, { expectedRevision: revision });
}
