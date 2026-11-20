import { basename, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { ProjectAutomateMe } from './project-automate-me.mjs';
import {
  ProjectInvestigations,
  investigationFocuses,
  investigationPrompts,
  projectDefaultBranch,
} from './project-investigations.mjs';
import { projectHomeStats } from './project-home-stats.mjs';
import { flowBranches } from './flow-branches.mjs';
import { flowTarget } from './flow-observer.mjs';
import { defaultIssueFolder, readIssueFolderSettings, resolveFolderSettings } from './issue-folder-settings.mjs';
import { requireThat, writeJson } from './common.mjs';

export class ProjectHome {
  constructor(service, flows, options = {}) {
    this.service = service;
    this.flows = flows;
    this.readOnly = options.readOnly === true;
    this.investigations = new ProjectInvestigations(service, flows, {
      ...options.investigations,
      readOnly: this.readOnly,
    });
    this.automateMe = new ProjectAutomateMe(service, { ...options.automateMe, readOnly: this.readOnly });
    const path = join(service.root, '.issues/factory-ui/project-home/history.json');
    if (!this.readOnly) {
      mkdirSync(join(path, '..'), { recursive: true });
      if (!existsSync(path)) writeJson(path, { since: new Date().toISOString() });
    }
    this.historySince = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).since : null;
    this.view = this.view.bind(this);
    this.action = this.action.bind(this);
    this.close = this.close.bind(this);
  }
  get activeCount() {
    return this.investigations.activeCount + (this.automateMe.activeCount ?? 0);
  }
  async view() {
    const { values, errors } = resolveFolderSettings(this.service.root, null);
    const branches = await flowBranches(this.service.root);
    const defaultBranch = projectDefaultBranch(branches, values.branch, flowTarget(this.service.root).remote);
    let defaultFolder = null;
    let folderError = null;
    try {
      defaultFolder = defaultIssueFolder(this.service.root).name;
    } catch (error) {
      folderError = error.message;
    }
    return {
      project: { name: basename(this.service.root), path: this.service.root },
      activeCount: this.activeCount,
      stats: projectHomeStats(this.service.root, new Date(), this.historySince),
      branches,
      defaultBranch: defaultBranch?.ref || null,
      configuredBranch: values.branch,
      settingsErrors: errors,
      folders: readIssueFolderSettings(this.service.root).map(({ id, name }) => ({ id, name })),
      defaultFolder,
      folderError,
      focuses: investigationFocuses,
      prompts: investigationPrompts,
      investigations: this.investigations.view(),
      automateMe: this.automateMe.view(),
    };
  }
  async action(input) {
    requireThat(!this.readOnly, 'This preview is read-only. Open the live project to start an operation.');
    this.service.ownServer();
    return String(input.action).startsWith('automate-')
      ? this.automateMe.action(input)
      : this.investigations.action(input);
  }
  close() {
    this.investigations.close();
    this.automateMe.close();
  }
}
