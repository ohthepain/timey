import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function withQueueConfiguration({ page, project, root }, run) {
  const configuration = ['triage-labels.md', 'preferences.json'].map((file) => {
    const path = join(project, '.issues', file);
    return { path, content: existsSync(path) ? readFileSync(path) : null };
  });
  copyFileSync(join(root, '.issues/triage-labels.md'), configuration[0].path);
  writeFileSync(configuration[1].path, '{"commit":true}');
  try {
    return await run();
  } finally {
    await page.goto('about:blank');
    for (const { path, content } of configuration) {
      if (content === null) rmSync(path);
      else writeFileSync(path, content);
    }
  }
}
