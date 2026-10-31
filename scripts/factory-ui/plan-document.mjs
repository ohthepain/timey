import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { requireThat } from './common.mjs';

export function readPlan(root, path) {
  requireThat(
    typeof path === 'string' && /^docs\/plans\/[\w./-]+\.md$/.test(path),
    'Choose a Markdown plan from this project.'
  );
  const directory = realpathSync(join(root, 'docs/plans')),
    file = realpathSync(join(root, path));
  requireContained(directory, file);
  requireThat(
    statSync(file).isFile() && statSync(file).size < 1048576,
    'The plan must be a Markdown file smaller than 1 MB.'
  );
  return { path, content: readFileSync(file, 'utf8') };
}

function requireContained(directory, file) {
  const child = relative(directory, file);
  requireThat(
    child && !child.startsWith('..') && !isAbsolute(child),
    'The plan must be inside this project’s plans folder.'
  );
}
