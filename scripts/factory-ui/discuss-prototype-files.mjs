import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { requireThat } from './common.mjs';

const stagingPath = '.cache/discuss-prototypes';
const mimeTypes = {
  '.png': 'image/png',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

function within(directory, path) {
  const suffix = relative(directory, path);
  return suffix && suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix);
}

export function prototypeAttachmentInputs(root, paths) {
  const project = realpathSync(root);
  const staging = join(project, stagingPath);
  requireThat(realpathSync(staging) === staging, 'Use a real prototype staging directory inside the project.');
  let total = 0;
  return paths.map((file) => {
    const name = basename(file);
    const mime = mimeTypes[extname(name).toLowerCase()];
    requireThat(
      !isAbsolute(file) && mime,
      'Use a PNG screenshot, HTML file, or ZIP in the prototype staging directory.'
    );
    const path = realpathSync(join(staging, file));
    requireThat(within(staging, path), 'Prototype files must be inside the prototype staging directory.');
    const stats = statSync(path);
    requireThat(stats.isFile(), 'Choose a regular prototype file.');
    total += stats.size;
    requireThat(total <= 8 * 1024 * 1024, 'Prototype files must total at most 8 MB.');
    return { name, mime, data: readFileSync(path).toString('base64') };
  });
}
