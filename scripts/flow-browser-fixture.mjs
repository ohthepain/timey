import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureProjectStores } from './factory-ui/stores/runtime.mjs';

export async function writeBrowserIssue(service, { id, title, body }) {
  const project = service.root;
  await ensureProjectStores(service);
  const report = `---\nid: ${id}\ntitle: ${title}\nstate: backlog\n---\n\n${body}\n`;
  writeFileSync(join(project, '.issues', id + '.md'), report);
  await service.projectStores.importIssue({ id, report, storeId: 'files', operationId: 'browser-fixture/' + id });
  await ensureProjectStores(service, { fresh: true });
}
