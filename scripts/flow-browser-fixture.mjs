import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeBrowserIssue(project, { id, title, body }) {
  writeFileSync(
    join(project, '.issues', id + '.md'),
    `---\nid: ${id}\ntitle: ${title}\nstate: backlog\n---\n\n${body}\n`
  );
}
