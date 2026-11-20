import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { requireThat } from './common.mjs';
import { SidebarFiles } from './sidebar-files.mjs';
import {
  createIssueFolderSettings,
  readFolderSettings,
  readIssueFolderSettings,
  updateFolderSettings,
  previewFolderRepair,
  repairFolderSettings,
} from './issue-folder-settings.mjs';

const run = promisify(execFile);

function directory(project, input) {
  if (input.project === true || input.project === 'true') return realpathSync(project);
  if (input.folder) {
    const folder = readIssueFolderSettings(project, { includeBroken: true, includeCopies: true }).find(
      ({ name }) => name === input.folder
    );
    requireThat(folder, 'Choose an existing folder.');
    return folder.directory;
  }
  return new SidebarFiles(project).locate(input, 'directory').path;
}

export function folderSettingsView(project, input) {
  return readFolderSettings(project, directory(project, input));
}

export async function changeFolderSettings(service, input) {
  service.ownServer();
  const path = directory(service.root, input);
  const view = readFolderSettings(service.root, path);
  if (input.action === 'open') {
    const target = input.file ? join(path, 'folder.md') : path;
    const file = lstatSync(target, { throwIfNoEntry: false });
    requireThat(input.file ? file?.isFile() : file?.isDirectory(), 'The selected file or folder no longer exists.');
    requireThat(process.platform === 'darwin', 'Open this path with your file manager.');
    await run('/usr/bin/open', [target], { timeout: 5000 });
    return { opened: true };
  }
  requireThat(view.canConfigure, 'Choose a project-owned folder for settings.');
  if (input.action === 'create') {
    requireThat(view.kind === 'plain', 'This folder already has a settings file.');
    const projectPath = relative(realpathSync(service.root), path).split(sep).join('/');
    createIssueFolderSettings(service.root, projectPath.startsWith('user/') ? projectPath.slice(5) : '/' + projectPath);
    return readFolderSettings(service.root, path);
  }
  if (input.action === 'repair-preview') return previewFolderRepair(service.root, path);
  const update = { directory: path, revision: input.revision, changes: input.changes || {} };
  if (input.action === 'repair') return repairFolderSettings(service.root, update);
  requireThat(['save', 'make-default'].includes(input.action), 'Choose a folder settings action.');
  return updateFolderSettings(service.root, {
    ...update,
    ...(input.action === 'make-default' && { makeDefault: input.makeDefault !== false }),
  });
}
