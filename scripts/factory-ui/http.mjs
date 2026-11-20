import { skillSetup } from './required-skills.mjs';
import { flowOwnsIssue } from './flow-ownership.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { issueStorageDirectory, migrateClosedIssues, storedIssuePath } from './issue-report-storage.mjs';
import { listIssueStorage, moveIssueStorage, readIssueStorageReport, storedIssueId } from './issue-storage-actions.mjs';
import { outputHistory } from './output-history.mjs';
import { prepareIssueDelivery, startIssueDelivery } from './issue-delivery.mjs';
import { changePriority } from './issue-priority.mjs';
import { changeImplementationOrder } from './implementation-order-route.mjs';
import { assignIssueFolder, createIssueFolder } from './issue-folders.mjs';
import { editProjectIssues } from './project-issues-bulk.mjs';
import { prepareDeployment } from './deployment.mjs';
import { serverControl } from './server-control.mjs';
import { toggleRoute } from './route-toggle.mjs';
import { createServer } from 'node:http';
import { runtimeInfo } from './runtime.mjs';
import { queueResponse } from './queue-response.mjs';
import { readQueue } from './data.mjs';
import { decisionBasis } from './recorded-result.mjs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { requireThat } from './common.mjs';
import { uiDirectory } from './ui-source.mjs';
import { ViewSources } from './view-sources.mjs';
import { prepareNativeChat, nativeChatStatus } from '../factory-native-chat.mjs';
import {
  mergeIssueStrategyPR,
  startIssueStrategy,
  stopIssueStrategy,
  verifyExternalIssueDelivery,
  verifyIssueStrategyAgain,
} from './issue-strategy.mjs';
import { recoverMergedStrategyDelivery } from './strategy-delivery-recovery.mjs';
import { saveDefaultModelSettings, saveIssueModelSettings } from './model-settings.mjs';
import { openIssueWorkFolder } from './open-issue-work-folder.mjs';
import { createIssueFlows } from './flow-service.mjs';
import { SidebarFiles } from './sidebar-files.mjs';
import { folderSettingsView, changeFolderSettings } from './folder-settings-routes.mjs';
import { folderStrategies, changeFolderStrategy } from './folder-strategies.mjs';
import { defaultIssueFolder } from './issue-folder-settings.mjs';
import { initializeProjectLifecycle, readProjectSettings } from './project-settings.mjs';
import { ProjectHome } from './project-home.mjs';
import { ProjectWorktreeCleanup } from './project-worktree-cleanup.mjs';
import { ProjectRemoteBranchCleanup } from './project-remote-branch-cleanup.mjs';
import { ProjectLocalBranchCleanup } from './project-local-branch-cleanup.mjs';
import { ProjectArchiveDeletion } from './project-archive-deletion.mjs';
import { ProjectDiscuss, readClarificationSkills } from './project-discuss.mjs';
import { LocalNotes } from './local-notes.mjs';
import { localNoteAction } from './local-note-routes.mjs';
import { controlServerAction } from './server-action.mjs';
import {
  deleteIssueWorktree,
  issueCleanupIdentities,
  previewIssueCleanup,
  previewIssueCleanupResource,
  previewIssueCleanupWorkspaceSize,
  startIssueCleanupRetry,
} from './issue-cleanup.mjs';
async function body(request) {
  const limit =
    request.url === '/api/project-discuss-action'
      ? 12000000
      : request.url === '/api/sidebar-files-action'
        ? 800000
        : 65536;
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    requireThat(Buffer.byteLength(text) < limit, 'Request too large.');
  }
  return JSON.parse(text || '{}');
}
function authenticated(request, token, port) {
  return (request.headers.cookie || '').split(';').some((value) => value.trim() === `timey_factory_${port}=${token}`);
}

export async function decideIssueAndCleanup(service, value) {
  const artifact = isFixedAcceptance(value) ? await fixedAcceptanceArtifact(service, value) : null;
  const useFlowClosure = value.flowRevision !== undefined && value.kind === 'close';
  if (value.flowRevision !== undefined) {
    requireThat(!flowOwnsIssue(service, value.issueId), 'Wait for the running block or stop it before closing.');
    service.serverControl?.allow('/api/issue-decision', value);
  }
  if (useFlowClosure) return flows(service).closeWithReason(value, artifact);
  const decision = await service.decideIssue(
    value.issueId,
    value.state,
    value.kind,
    value.basis,
    value.reason,
    value.resolution,
    value.cleanup,
    artifact
  );
  if (value.kind === 'close') service.flows?.pauseAutoplay(value.issueId, 'Issue closed');
  if (value.kind === 'reopen' && service.flows) service.flows.reopened(value.issueId);
  return decision;
}

async function fixedAcceptanceArtifact(service, value) {
  if (value.flowRevision !== undefined) {
    const artifact = await flows(service).manualClosureArtifact(value.issueId, value.flowRevision);
    if (artifact) return artifact;
  }
  const issue = readQueue(service.root).issues.find((entry) => entry.id === value.issueId);
  if (issue) await recoverMergedStrategyDelivery(service, issue);
  return null;
}

function isFixedAcceptance(value) {
  return value.kind === 'close' && (!value.resolution || value.resolution === 'fixed');
}

function authorize(request, token, port) {
  requireThat(request.headers.host === `127.0.0.1:${port}`, 'Use the local URL printed by this server.');
  requireThat(
    authenticated(request, token, port),
    'This page session expired, possibly because the local server restarted. Reload this page and try again. No action was performed.'
  );
  if (request.method === 'POST') {
    requireThat(
      request.headers.origin === `http://127.0.0.1:${port}`,
      'This operation must come from the local factory page.'
    );
    requireThat(
      request.headers['x-factory-action'] === 'manual' && request.headers['content-type'] === 'application/json',
      'Explicit JSON actions are required.'
    );
  }
}
function requireClassicIdle(service, path, value) {
  if (['/api/flow-action', '/api/issue-storage-move'].includes(path)) return;
  if (value.issueId)
    requireThat(
      !flowOwnsIssue(service, value.issueId),
      'A flow block owns this issue. Stop it before using classic controls.'
    );
}

const pauseSafeActions = {
  '/api/local-notes-action': ['create', 'edit', 'complete', 'delete', 'move', 'discuss', 'link'],
  '/api/project-discuss-action': ['stop', 'answer', 'draft', 'settings', 'edit-queued', 'remove-queued', 'delete-note'],
  '/api/flow-action': ['stop', 'pause', 'cancel-confirmation', 'folder-night-stop', 'branch-repair-stop'],
  '/api/project-home-action': ['investigation-stop', 'automate-stop'],
};
function mayFinishWhilePaused(path, value) {
  return pauseSafeActions[path]?.includes(value.action);
}

async function mutation(service, path, value, owner) {
  requireLiveMutation(service, path);
  requireClassicIdle(service, path, value);
  if (!mayFinishWhilePaused(path, value)) service.serverControl?.allow(path, value);
  const discussionRoutes = {
    '/api/site-review-open': () => service.siteReviews.open(value, owner),
    '/api/site-review-decide': () => service.siteReviews.decide(value, owner),
    '/api/discussion-open': () => service.discussions.open(value, owner),
    '/api/discussion-turn': () => service.discussions.turn(value, owner),
    '/api/discussion-skills': () => service.discussions.skills(value, owner),
    '/api/discussion-retro': () => service.discussions.retro(value, owner),
    '/api/discussion-retro-saved': () => service.discussions.savedRetro(value, owner),
    '/api/discussion-retro-file': () => service.discussions.fileRetro(value, owner),
    '/api/discussion-summary': () => service.discussions.summarize(value, owner),
    '/api/discussion-prepare': () => service.discussions.prepare(value, owner),
    '/api/discussion-commit': () => service.discussions.commit(value, owner),
    '/api/discussion-end': () => service.discussions.end(value, owner),
  };
  if (path.startsWith('/api/site-review-')) {
    requireThat(Object.hasOwn(discussionRoutes, path), 'Unknown site review operation.');
    return discussionRoutes[path]();
  }
  if (Object.hasOwn(discussionRoutes, path)) return temporaryAction(discussionRoutes[path]);
  const routes = {
    '/api/local-notes-action': () => localNoteAction(service, value, () => projectDiscuss(service)),
    '/api/project-discuss-action': () => projectDiscuss(service).action(value),
    '/api/project-home-action': () => projectHome(service).action(value),
    '/api/project-worktree-cleanup': () => worktreeCleanup(service).apply(value),
    '/api/project-remote-branch-cleanup': () => remoteBranchCleanup(service).apply(value),
    '/api/project-local-branch-cleanup': () => localBranchCleanup(service).apply(value),
    '/api/project-archive-deletion': () => archiveDeletion(service).apply(value),
    '/api/folder-settings': () => changeFolderSettings(service, value),
    '/api/folder-strategies': () => {
      service.ownServer();
      return changeFolderStrategy(service.root, value);
    },
    '/api/folder-delete': () => flows(service).deleteFolder(value),
    '/api/sidebar-files-action': () => new SidebarFiles(service.root).change(value),
    '/api/project-settings-initialize': () => initializeProjectLifecycle(service, value),
    '/api/ui-sources': () => {
      service.ownServer();
      return viewSources(service).edit(value.id, value.revision, value.label);
    },
    '/api/flow-action': () => flows(service).action(value),
    '/api/native-chat-prepare': () => {
      service.ownServer();
      return prepareNativeChat(service.root, value);
    },
    '/api/issue-strategy-stop': () => stopIssueStrategy(service, value),
    '/api/issue-strategy-start': () => startIssueStrategy(service, value),
    '/api/issue-strategy-verify-again': () => verifyIssueStrategyAgain(service, value),
    '/api/issue-strategy-merge': () => mergeIssueStrategyPR(service, value),
    '/api/issue-strategy-external-delivery': () => verifyExternalIssueDelivery(service, value),
    '/api/issue-work-folder-open': () => openIssueWorkFolder(service, value.issueId),
    '/api/assembly-retry': () => service.retryAssembly(value),
    '/api/issue-delivery-preflight': () => prepareIssueDelivery(service, value.kind, value.input),
    '/api/issue-delivery-start': () => startIssueDelivery(service, value.token, value.humanApproved),
    '/api/shared-queue-refresh': () => {
      service.ownServer();
      return { warning: service.sharedIssues?.refresh(true) };
    },
    '/api/shared-queue-retry': () => {
      service.ownServer();
      return service.sharedIssues?.retry(value.issueId);
    },
    '/api/shared-queue-confirm': () => {
      service.ownServer();
      return service.sharedIssues?.confirm(value.issueId);
    },
    '/api/shared-queue-publish-draft': () => {
      service.ownServer();
      return service.sharedIssues?.publishDraft(value.issueId);
    },
    '/api/shared-queue-handoff': () => {
      service.ownServer();
      return service.sharedIssues?.handoff(value.issueId);
    },
    '/api/shared-queue-recover': () => {
      service.ownServer();
      requireThat(value.confirmedStopped === true, 'Confirm the previous runner has stopped.');
      return service.sharedIssues?.recover(value.issueId);
    },
    '/api/issue-storage-migrate': () => {
      service.ownServer();
      return { moved: migrateClosedIssues(service.root).length };
    },
    '/api/issue-storage-move': () => moveIssueStorage(service, value),
    '/api/issue-report-reveal': () => revealIssueReport(service, value.issueId),
    '/api/issue-storage-open-folder': async () => {
      requireThat(process.platform === 'darwin', 'Finder is available on macOS.');
      const folder = issueStorageDirectory(service.root, value.location);
      mkdirSync(folder, { recursive: true });
      await promisify(execFile)(
        '/usr/bin/open',
        ['-a', 'Finder', issueStorageDirectory(service.root, value.location)],
        {
          timeout: 5000,
        }
      );
      return { opened: true };
    },
    '/api/issue-capture': () => service.captures.save(value),
    '/api/integration-recovery-retry': () => service.retryIntegrationRecovery(value),
    '/api/verification-retry': () => service.retryVerification(value),
    '/api/coordinator-send': () => service.coordinator.message(value),
    '/api/coordinator-stop': () => service.coordinator.stop(),
    '/api/coordinator-continue': () => service.coordinator.continue(),
    '/api/coordinator-fresh': () => service.coordinator.fresh(),
    '/api/issue-chat-control': () => service.issueChats.control(value),
    '/api/issue-chat-send': () => service.issueChats.send(value),
    '/api/issue-chat-stop': () => service.issueChats.stop(value),
    '/api/issue-cleanup-preview': () => previewIssueCleanup(service, value.issueId, value.resolution),
    '/api/issue-cleanup-identities': () =>
      issueCleanupIdentities(
        value.flow ? flows(service).cleanupContext(value.issueId) : service,
        value.issueId,
        value.resolution
      ),
    '/api/issue-cleanup-resource': () =>
      previewIssueCleanupResource(
        value.flow ? flows(service).cleanupContext(value.issueId) : service,
        value.issueId,
        value.resourceId,
        value.resolution
      ),
    '/api/issue-cleanup-workspace-size': () =>
      previewIssueCleanupWorkspaceSize(
        value.flow ? flows(service).cleanupContext(value.issueId) : service,
        value.issueId,
        value.resourceId
      ),
    '/api/issue-cleanup-retry': () => startIssueCleanupRetry(service, value.issueId, value.resourceId || null),
    '/api/issue-worktree-delete': () => deleteIssueWorktree(service, value),
    '/api/server-pause': () => service.serverControl.pause(),
    '/api/server-restart': () => service.serverControl.request(),
    '/api/server-cancel-restart': () => service.serverControl.cancel(),
    '/api/server-action': () => controlServerAction(service, value),
    '/api/lifecycle-start': () => service.startLifecycle(value),
    '/api/lifecycle-answer': () => service.answerLifecycle(value),
    '/api/lifecycle-pause': () => service.pauseLifecycle(value),
    '/api/approve-review-file': () => service.approveReviewFile(value),
    '/api/issue-priority': () => changePriority(service, value),
    '/api/project-issues-bulk-edit': () => editProjectIssues(service, value, projectHome(service)),
    '/api/implementation-order': () => changeImplementationOrder(service, value),
    '/api/issue-folder-create': () => {
      service.ownServer();
      const queue = readQueue(service.root);
      return createIssueFolder(service.root, queue.issues, value);
    },
    '/api/issue-folder-assign': () => {
      service.ownServer();
      const queue = readQueue(service.root);
      return assignIssueFolder(service.root, queue.issues, value);
    },
    '/api/model-settings': () => saveDefaultModelSettings(service, value),
    '/api/issue-model-settings': () => saveIssueModelSettings(service, value),
    '/api/toggle-route': () => toggleRoute(service, value),
    '/api/skip-plan-checks': () => service.skipPlanChecks(value),
    '/api/check-implementation': () => service.checkImplementation(value.issueId, value.state, value.path, value.basis),
    '/api/plan-decision': () =>
      service.decidePlanCheck(value.issueId, value.state, value.checkId, value.status, value.basis, value.result),
    '/api/find-worker': () => service.findConnection(value.issueId, value.state, value.basis),
    '/api/connect-worker': () => service.connectWorker(value.issueId, value.state, value.basis, value.link),
    '/api/issue-decision': () => decideIssueAndCleanup(service, value),
    '/api/check-readiness': () => service.checkReadiness(value.issueId, value.state),
    '/api/progress-preflight': () => service.progressPreflight(value.issueId, value.state),
    '/api/progress-start': () => service.progressStart(value.token, value.humanApproved),
    '/api/evaluate': () => service.evaluate(value.basis),
    '/api/save-review': () => service.saveReview(value.runId, value.basis),
    '/api/preflight': () => service.preflight(value.actionId, value.kind),
    '/api/start': () => service.start(value.token, value.humanApproved),
    '/api/resume': () => service.resume(value.runId, value.text),
    '/api/answer': () => service.answer(value.runId, value.requestId, value.response),
  };
  if (Object.hasOwn(routes, path)) return routes[path]();
  throw Error('Unknown operation. No action was taken.');
}
export function createFactoryServer(service, options = {}) {
  service.serverControl = serverControl(service, options.restart);
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const projectIssueEmbed = request.method === 'GET' && request.url.startsWith('/classic?embed=project-issues');
    const projectIssueRequestEmbed =
      request.method === 'GET' && request.url.startsWith('/?embed=project-issue-request');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors ${projectIssueEmbed || projectIssueRequestEmbed ? "'self'" : "'none'"}; base-uri 'none'; form-action 'self'`
    );
    try {
      requireThat(request.headers.host === `127.0.0.1:${server.address().port}`, 'Use the local factory address.');
      if (request.method === 'GET' && request.url === '/api/health') {
        response.statusCode = 204;
        return response.end();
      }
      await respond(service, request, response, token, server.address().port);
    } catch (error) {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.once('close', () => service.serverControl.close());
  return server;
}

async function respond(service, request, response, token, port) {
  if (isPage(request)) return page(service, request, response, token, port);
  authorize(request, token, port);
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET') return readResource(service, request, response, token);
  if (request.method === 'POST') return response.end(JSON.stringify(await postedAction(service, request, token)));
  response.statusCode = 405;
  response.end(JSON.stringify({ error: 'Unsupported method' }));
}
function page(service, request, response, token, port) {
  response.setHeader('Set-Cookie', `timey_factory_${port}=${token}; HttpOnly; SameSite=Strict; Path=/`);
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  const name = request.url.startsWith('/native-chat?')
    ? 'native-chat.html'
    : request.url.startsWith('/classic')
      ? 'index.html'
      : 'flow.html';
  response.end(readFileSync(join(uiDirectory(service), name)));
}
async function read(service, request, response, owner) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const selectedIssue = url.searchParams.get('issue');
  const issue = (value) => resolveIssueNumber(service, value);
  const routes = {
    '/api/folder-settings': () => {
      flows(service);
      return folderSettingsView(service.root, Object.fromEntries(url.searchParams));
    },
    '/api/folder-strategies': () => folderStrategies(service.root, url.searchParams.get('folder')),
    '/api/folder-delete-preview': () => flows(service).previewFolderDeletion(Object.fromEntries(url.searchParams)),
    '/api/sidebar-files': () => new SidebarFiles(service.root).index(),
    '/api/sidebar-directory': () => new SidebarFiles(service.root).directory(Object.fromEntries(url.searchParams)),
    '/api/sidebar-file': () => new SidebarFiles(service.root).file(Object.fromEntries(url.searchParams)),
    '/api/project-settings': () => readProjectSettings(service.root),
    '/api/project-home': () => projectHome(service).view(),
    '/api/local-notes': () => new LocalNotes(service.root).view(),
    '/api/project-worktree-cleanup': () => worktreeCleanup(service).preview(url.searchParams.get('ref')),
    '/api/project-remote-branch-cleanup': () => remoteBranchCleanup(service).preview(),
    '/api/project-local-branch-cleanup': () => localBranchCleanup(service).preview(url.searchParams.get('ref')),
    '/api/project-archive-deletion': () => archiveDeletion(service).preview(),
    '/api/project-discuss': () => projectDiscuss(service).view(url.searchParams.get('conversation')),
    '/api/project-discuss-skills': async () => {
      const skills = await projectDiscuss(service).skills();
      const choices = readClarificationSkills(service.root);
      return {
        skills,
        setup: skillSetup(
          skills,
          choices.filter((entry) => entry.kind === 'skill').map((entry) => entry.skill),
          service.root,
          Object.fromEntries(choices.filter((entry) => entry.source).map((entry) => [entry.name, entry.source]))
        ),
      };
    },
    '/api/investigation': () =>
      projectHome(service).investigations.issueView(new URL(request.url, 'http://localhost').searchParams.get('issue')),
    '/api/ui-sources': () => ({ ...viewSources(service).update(), editable: service.reviewMode !== 'preview' }),
    '/api/issue-folder-options': () => flows(service).folders(),
    '/api/issue-folder-default': () => {
      flows(service);
      try {
        return { folder: defaultIssueFolder(service.root).name };
      } catch (error) {
        return { folder: null, error: error.message };
      }
    },
    '/api/flow': () =>
      flows(service).view(issue(selectedIssue), {
        requestOnly: url.searchParams.get('view') === 'request',
      }),
    '/api/flow-files': () => flows(service).files(issue(selectedIssue)),
    '/api/flow-file': () => flows(service).file(issue(selectedIssue), url.searchParams.get('path')),
    '/api/native-chat': () => nativeChatStatus(service.root, issue(url.searchParams.get('issue'))),
    '/api/runtime': () => ({ ...runtimeInfo(service), server: service.serverControl.status() }),
    '/api/server-status': () => service.serverControl.status(),
    '/api/server-actions': () => service.serverControl.actions(),
    '/api/coordinator': () => service.coordinator.view(),
    '/api/issue-chat': () =>
      service.issueChats.view(issue(url.searchParams.get('issue')), url.searchParams.get('before') || ''),
    '/api/issue-chat-skills': () => service.issueChats.skills(issue(url.searchParams.get('issue'))),
    '/api/document': () => service.readPlan(url.searchParams.get('path')),
    '/api/shown-file': () => service.readShownFile(url.searchParams.get('path')),
    '/api/issue-storage': () => listIssueStorage(service, url.searchParams.get('location')),
    '/api/issue-storage-report': () =>
      readIssueStorageReport(service.root, issue(url.searchParams.get('issue')), url.searchParams.get('location')),
    '/api/issue-report': () => service.readSavedReport(issue(url.searchParams.get('issue'))),
    '/api/check-evidence': () =>
      service.readChecklistEvidence(issue(url.searchParams.get('issue')), url.searchParams.get('path')),
    '/api/issue': () => issueResponse(service, owner, issue(selectedIssue)),
    '/api/issue-closure': () =>
      issueClosureContext(service, issue(selectedIssue), url.searchParams.get('kind') === 'reopen'),
    '/api/queue': () =>
      selectedIssue ? issueResponse(service, owner, issue(selectedIssue)) : queueResponse(service.snapshot(owner)),
    '/api/output-history': () =>
      outputHistory(service.store, url.searchParams.get('id'), url.searchParams.get('before')),
    '/api/run': () => savedRun(service, url.searchParams.get('id')),
  };
  if (Object.hasOwn(routes, url.pathname)) return response.end(JSON.stringify(await routes[url.pathname]()));
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'Not found' }));
}

async function revealIssueReport(service, issueId) {
  requireThat(process.platform === 'darwin', 'Finder is available on macOS.');
  const { path } = service.readSavedReport(issueId);
  await promisify(execFile)('/usr/bin/open', ['-R', join(service.root, path)], { timeout: 5000 });
  return { opened: true };
}

function closureReportLocation(root, issueId, reopen) {
  return reopen && !existsSync(storedIssuePath(root, issueId)) ? 'closed' : 'open';
}

function issueClosureContext(service, issueId, reopen) {
  requireThat(typeof issueId === 'string' && /^[\w-]+$/.test(issueId), 'Choose a valid saved issue ID.');
  const location = closureReportLocation(service.root, issueId, reopen);
  const queue = readQueue(service.root, { location, issueId });
  const issue = queue.issues.find((entry) => entry.id === issueId);
  const closed = queue.lifecycle.some((stage) => stage.role === 'closed' && stage.state === issue?.state);
  requireThat(
    issue && closed === reopen,
    reopen ? 'This issue is no longer closed.' : 'This issue is no longer open. Refresh to see its saved closure.'
  );
  return {
    issueId,
    state: issue.state,
    basis: decisionBasis(queue, issue),
    closureReasons: queue.closureReasons,
    sharedQueue: Boolean(service.sharedIssues),
  };
}

function issueResponse(service, owner, id) {
  requireThat(typeof id === 'string' && /^[\w-]+$/.test(id), 'Choose a valid saved issue ID.');
  return queueResponse(service.snapshot(owner, { includeCoordinatorDiscussion: false, selectedIssue: id }), id);
}

function isPage(request) {
  return request.method === 'GET' && ['/', '/flow', '/classic', '/native-chat'].includes(request.url.split('?')[0]);
}

async function temporaryAction(action) {
  try {
    return await action();
  } catch {
    throw Error('Discussion could not complete. Refresh or start a new temporary discussion.');
  }
}

function readResource(service, request, response, owner) {
  if (request.url === '/discuss-markdown.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return response.end(readFileSync(createRequire(import.meta.url).resolve('markdown-it/dist/markdown-it.min.js')));
  }
  if (request.url.startsWith('/api/project-discuss-attachment?')) {
    const url = new URL(request.url, 'http://localhost');
    const file = projectDiscuss(service).attachment(
      url.searchParams.get('conversation'),
      url.searchParams.get('attachment')
    );
    const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime);
    response.setHeader('Content-Type', image ? file.mime : 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Disposition',
      `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`
    );
    return response.end(readFileSync(file.path));
  }
  if (request.url === '/favicon.ico') {
    response.statusCode = 204;
    return response.end();
  }
  const scripts = {
    '/local-notes-ui.js': 'local-notes-ui.js',
    '/local-notes.css': 'local-notes.css',
    '/project-discuss-ui.js': 'project-discuss-ui.js',
    '/skill-select.js': 'skill-select.js',
    '/project-discuss.css': 'project-discuss.css',
    '/flow-ui.js': 'flow-ui.js',
    '/branch-repair-ui.js': 'branch-repair-ui.js',
    '/project-home-ui.js': 'project-home-ui.js',
    '/project-admin-ui.js': 'project-admin-ui.js',
    '/investigation-issue-ui.js': 'investigation-issue-ui.js',
    '/project-home.css': 'project-home.css',
    '/issue-folder-drag-ui.js': 'issue-folder-drag-ui.js',
    '/sidebar-files-ui.js': 'sidebar-files-ui.js',
    '/folder-settings-ui.js': 'folder-settings-ui.js',
    '/investigation-followups-ui.js': 'investigation-followups-ui.js',
    '/view-inspection.js': 'view-inspection.js',
    '/flow.css': 'flow.css',
    '/native-chat-ui.js': 'native-chat-ui.js',
    '/server-control-ui.js': 'server-control-ui.js',
    '/queue-lifecycle-ui.js': 'queue-lifecycle-ui.js',
    '/queue-sort-ui.js': 'queue-sort-ui.js',
    '/file-link-ui.js': 'file-link-ui.js',
    '/coordinator-ui.js': 'coordinator-ui.js',
    '/issue-progress-ui.js': 'issue-progress-ui.js',
    '/issue-closure-ui.js': 'issue-closure-ui.js',
    '/issue-chat-ui.js': 'issue-chat-ui.js',
    '/site-review-ui.js': 'site-review-ui.js',
    '/discussion-ui.js': 'discussion-ui.js',
    '/issue-capture-ui.js': 'issue-capture-ui.js',
  };
  if (Object.hasOwn(scripts, request.url)) {
    response.setHeader(
      'Content-Type',
      request.url.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
    );
    return response.end(readFileSync(join(uiDirectory(service), basename(scripts[request.url]))));
  }
  return read(service, request, response, owner);
}

function flows(service) {
  service.flows ||= createIssueFlows(service);
  return service.flows;
}

function projectHome(service) {
  const readOnly = service.reviewMode === 'preview';
  if (!readOnly) service.ownServer();
  service.projectHome ||= new ProjectHome(service, readOnly ? null : flows(service), {
    ...service.projectHomeOptions,
    readOnly,
  });
  return service.projectHome;
}

function worktreeCleanup(service) {
  service.projectWorktreeCleanup ||= new ProjectWorktreeCleanup(service);
  return service.projectWorktreeCleanup;
}

function remoteBranchCleanup(service) {
  service.projectRemoteBranchCleanup ||= new ProjectRemoteBranchCleanup(service, service.remoteBranchCleanupOptions);
  return service.projectRemoteBranchCleanup;
}

function localBranchCleanup(service) {
  service.projectLocalBranchCleanup ||= new ProjectLocalBranchCleanup(service, service.localBranchCleanupOptions);
  return service.projectLocalBranchCleanup;
}

function archiveDeletion(service) {
  service.projectArchiveDeletion ||= new ProjectArchiveDeletion(service, localBranchCleanup(service));
  return service.projectArchiveDeletion;
}

function projectDiscuss(service) {
  service.projectDiscuss ||= new ProjectDiscuss(service, {
    ...service.projectDiscussOptions,
    home: () => projectHome(service),
    flows: () => flows(service),
  });
  return service.projectDiscuss;
}

function viewSources(service) {
  service.viewSources ||= new ViewSources(service.root, flows(service).catalog);
  return service.viewSources;
}

function savedRun(service, id) {
  const run = service.store.list(service.permissionRequests()).find((item) => item.id === id);
  requireThat(run, 'This saved run no longer exists.');
  return run;
}

function requireLiveMutation(service, path) {
  if (service.reviewMode === 'preview')
    requireThat(
      ['/api/discussion-skills', '/api/discussion-end'].includes(path),
      'This is a preview copy. Make changes and record approvals on the real issue.'
    );
}

function deploymentAction(service, path) {
  if (path === '/api/deployment-prepare') return prepareDeployment(service);
  if (path === '/api/deployment-cancel') {
    service.deploymentDraining = false;
    return { cancelled: true };
  }
  throw Error('Unknown deployment operation.');
}

async function postedAction(service, request, token) {
  if (request.url.startsWith('/api/deployment-')) return deploymentAction(service, request.url);
  requireThat(!service.deploymentDraining, 'The factory UI is restarting. Refresh when it is ready.');
  const value = await body(request);
  if (typeof value.issueId === 'string') value.issueId = resolveIssueNumber(service, value.issueId);
  return mutation(service, request.url, value, token);
}

function resolveIssueNumber(service, value) {
  return storedIssueId(service.root, value);
}
