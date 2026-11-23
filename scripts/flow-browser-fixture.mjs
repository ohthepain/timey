import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registeredProjectStores } from './factory-ui/stores/report-access.mjs';
import { resolveIssueStorage } from './factory-ui/stores/settings.mjs';

export async function writeBrowserIssue(project, { id, title, body }) {
  const report = `---\nid: ${id}\ntitle: ${title}\nstate: backlog\n---\n\n${body}\n`;
  const stores = registeredProjectStores(project);
  if (!stores) {
    writeFileSync(join(project, '.issues', id + '.md'), report);
    return;
  }
  const { storeId, artifactStoreId } = resolveIssueStorage(project);
  await stores.importIssue({ id, report, storeId, artifactStoreId, operationId: 'fixture-' + id });
  await stores.refresh({ issueIds: [id] });
}
