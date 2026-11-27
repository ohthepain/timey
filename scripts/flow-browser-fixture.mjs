import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { registeredProjectStores } from './factory-ui/stores/report-access.mjs';
import { storedIssuePath } from './factory-ui/issue-report-storage.mjs';
import { resolveIssueStorage } from './factory-ui/stores/settings.mjs';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';

export function installBrowserHumanInput(project, root) {
  const helper = '.agents/skills/issues/scripts';
  mkdirSync(join(project, helper), { recursive: true });
  for (const file of ['human-input.mjs', 'human-input-version.json'])
    copyFileSync(join(root, helper, file), join(project, helper, file));
}

export async function writeBrowserIssue(project, { id, title, body }) {
  if (typeof project !== 'string') {
    const service = project;
    await ensureProjectStores(service);
    project = service.root;
  }
  const report = `---\nid: ${id}\ntitle: ${title}\nstate: backlog\n---\n\n${body}\n`;
  return importBrowserIssue(project, id, report);
}

export async function importBrowserIssue(project, id, report, location = 'open', number) {
  const stores = registeredProjectStores(project);
  if (!stores) {
    const path = storedIssuePath(project, id, location);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report);
    return;
  }
  const { storeId, artifactStoreId } = resolveIssueStorage(project);
  await stores.importIssue({ id, number, report, location, storeId, artifactStoreId, operationId: 'fixture-' + id });
  await stores.refresh({ issueIds: [id] });
}

export async function removeBrowserIssue(project, id) {
  const stores = registeredProjectStores(project);
  if (!stores) {
    for (const location of ['open', 'closed', 'archive'])
      rmSync(storedIssuePath(project, id, location), { force: true });
    rmSync(join(project, '.issues/flows', id), { recursive: true, force: true });
    return;
  }
  const current = await stores.readIssue(id);
  const result = await stores.deleteIssue({
    issueId: id,
    expectedRevision: current.revision,
    operationId: 'delete-fixture-' + id,
    purpose: current.location === 'archive' ? 'archive' : 'pending',
  });
  assert.equal(result.status, 'confirmed');
  await stores.refresh({ issueIds: [id] });
}
