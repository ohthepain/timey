import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { requireThat } from './common.mjs';

// An issue ID is the only browser input; reports belong to the authoritative queue.
export function readSavedReport(project, id) {
  requireThat(typeof id === 'string' && /^[\w-]+$/.test(id), 'Choose a valid saved issue ID.');
  let descriptor;
  try {
    const root = realpathSync(project),
      directory = join(root, '.issues'),
      file = join(directory, id + '.md');
    requireThat(realpathSync(directory) === directory, 'The saved report must be inside this project’s issue folder.');
    requireThat(
      realpathSync(file) === file,
      'The saved report must be inside this project’s issue folder and cannot be a symlink.'
    );
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    requireThat(fstatSync(descriptor).isFile(), 'The saved report must be a regular Markdown file.');
    const content = readFileSync(descriptor, 'utf8'),
      frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    requireThat(
      frontmatter && parse(frontmatter[1])?.id === id,
      'The saved report does not belong to the selected issue.'
    );
    return { path: '.issues/' + id + '.md', content };
  } catch (error) {
    if (error.code === 'ENOENT')
      throw Error('The saved issue report is missing. Refresh the issue page and try again.');
    if (error.code === 'ELOOP') throw Error('The saved report cannot be a symlink.');
    if (error.code)
      throw Error('The saved issue report could not be read. Check that it is a readable regular Markdown file.');
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
