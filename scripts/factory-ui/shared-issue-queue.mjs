import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { digest, readJson, requireThat, writeJson } from './common.mjs';
import { moveStoredIssue, storedIssuePath } from './issue-report-storage.mjs';
import { createSharedIssueClaims } from './shared-issue-claims.mjs';
import { sharedIssueQueueConfig } from './shared-issue-config.mjs';
import { createSharedIssuePublication } from './shared-issue-publication.mjs';
import { copySharedIssueFile, syncSharedIssueFiles } from './shared-issue-sync.mjs';

function withSharedProgress(report, status) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;
  return report.replace(frontmatter, (_, fields) => {
    const update = new Date().toISOString();
    const retained = fields.replace(/^shared_progress:.*\r?\n?/m, '').replace(/^updated:.*$/m, 'updated: ' + update);
    return `---\n${retained}\nshared_progress: ${status || 'unknown'}\n---`;
  });
}

export function createSharedIssueQueue(service, options = {}) {
  if (service.reviewMode === 'preview') return null;
  const root = service.root;
  const config = sharedIssueQueueConfig(root);
  if (!config) return null;
  const claims = createSharedIssueClaims({ root, ...config });
  const publication = createSharedIssuePublication({ root, ...config, ...options });
  const directory = join(root, '.issues/shared-queue');
  mkdirSync(directory, { recursive: true });
  const syncState = join(directory, 'target-files.json');
  let remoteClaims = new Map();
  let lastRefresh = 0;
  let syncWarning = null;

  function receiptPath(id) {
    requireThat(/^\d[\w-]*$/.test(id), 'Select a valid issue.');
    return join(directory, id + '.json');
  }
  function receipt(id) {
    const path = receiptPath(id);
    return existsSync(path) ? readJson(path) : null;
  }
  function save(record, fields) {
    Object.assign(record, fields);
    writeJson(receiptPath(record.id), record);
    return record;
  }
  function localReport(id, location = 'open') {
    return readFileSync(storedIssuePath(root, id, location), 'utf8');
  }
  function sameReport(id, location, content) {
    const path = storedIssuePath(root, id, location);
    return existsSync(path) && lstatSync(path).isFile() && readFileSync(path, 'utf8') === content;
  }
  function completeLocation(record) {
    if (record.location === undefined || record.location === record.baseLocation) return;
    if (record.storageAction === 'archive') {
      requireThat(sameReport(record.id, 'archive', record.base), 'The local archive copy needs reconciliation.');
      const closed = storedIssuePath(root, record.id, 'closed');
      if (!existsSync(closed)) return;
      requireThat(sameReport(record.id, 'closed', record.base), 'The local closed report changed.');
      unlinkSync(closed);
      return;
    }
    const from = record.storageAction === 'restore' ? 'archive' : record.baseLocation;
    if (!from) return;
    if (sameReport(record.id, record.location, record.report) && !existsSync(storedIssuePath(root, record.id, from)))
      return;
    requireThat(sameReport(record.id, from, record.report), 'The local report changed while awaiting review.');
    moveStoredIssue(root, record.id, from, record.location);
  }
  function active(id) {
    return (
      service.lifecycleTasks.has(id) ||
      service.issueChats.tasks.has(id) ||
      service.store.runs.some((run) => run.issueId === id && service.store.connected.has(run.id))
    );
  }
  function release(id, claim) {
    claims.release(claim);
    if (remoteClaims.get(id)?.oid === claim.oid) remoteClaims.delete(id);
  }
  function publishConfirmed(record, result) {
    if (result.number) publication.confirmMerged(record.id);
    completeLocation(record);
    const own = claims.own(record.id);
    if (own && record.claim?.oid === own.oid) release(record.id, own);
    return save(record, { status: 'published', url: result.url, error: null });
  }
  function reconcile(record) {
    if (record.status !== 'review' || active(record.id)) return;
    const result = publication.inspect(record.id);
    if (result?.status === 'landed') publishConfirmed(record, result);
  }
  function refresh(force = false) {
    if (!force && Date.now() - lastRefresh < 30_000) return syncWarning;
    lastRefresh = Date.now();
    try {
      remoteClaims = claims.list();
      for (const file of readdirSync(directory)) {
        if (!/^\d.*\.json$/.test(file)) continue;
        const record = receipt(file.slice(0, -5));
        try {
          reconcile(record);
        } catch {
          save(record, {
            status: 'failed',
            error: 'Could not reconcile the report PR or release its claim. Review it before retrying.',
          });
        }
      }
      const conflicts = syncSharedIssueFiles(root, config, syncState, active);
      syncWarning = conflicts.length
        ? 'Shared queue changes need reconciliation for ' + conflicts.join(', ') + '.'
        : null;
    } catch {
      syncWarning = 'Could not refresh the shared queue. The last observed queue is shown.';
    }
    return syncWarning;
  }
  function baseline(id, location = 'open') {
    const key = (location === 'closed' ? 'closed/' : '') + id + '.md';
    return existsSync(syncState) ? readJson(syncState)[key]?.hash : undefined;
  }
  function acquire(issue, allowDraft = false, restoring = false) {
    const pending = receipt(issue.id);
    requireThat(
      !pending || pending.status === 'published',
      'Publish or reconcile the pending issue update before starting.'
    );
    const initial = publication.readTarget(issue.id);
    requireThat(
      restoring
        ? initial.report === null
        : initial.report !== null &&
            (initial.report === issue.content ||
              (allowDraft && baseline(issue.id, initial.location) === digest(initial.report))),
      'The shared issue changed or is unpublished. Refresh the shared queue before starting.'
    );
    const claim = claims.acquire(issue.id);
    remoteClaims.set(issue.id, claim);
    try {
      const current = publication.readTarget(issue.id);
      requireThat(
        current.report === initial.report && current.location === initial.location,
        'The shared issue changed while it was being claimed. Refresh the shared queue before starting.'
      );
    } catch (error) {
      release(issue.id, claim);
      throw error;
    }
    const context = { claim, base: initial.report, baseLocation: initial.location };
    save({ id: issue.id, ...context }, { status: 'claimed' });
    return context;
  }
  function publish(record, reprepare = false) {
    try {
      const publishReport = reprepare ? publication.reprepare : publication.publish;
      const result = publishReport({
        issueId: record.id,
        base: { report: record.base, location: record.baseLocation ?? (record.base === null ? null : 'open') },
        location: record.location === undefined ? 'open' : record.location,
        report: record.report,
        reason: record.reason,
      });
      if (result.status === 'landed') return publishConfirmed(record, result);
      return save(record, { status: 'review', url: result.url, error: null });
    } catch (error) {
      return save(record, { status: 'failed', error: error.message });
    }
  }
  function checkpoint(
    id,
    reason,
    context = { base: null },
    report = localReport(id, context.baseLocation || 'open'),
    location = context.baseLocation || 'open',
    storageAction
  ) {
    const previous = receipt(id);
    if (
      previous &&
      previous.status !== 'published' &&
      !(previous.status === 'claimed' && previous.claim?.oid === context.claim?.oid)
    ) {
      if (previous.reason === reason && previous.report === report) return previous;
      throw Error('A different shared queue update is already pending.');
    }
    return publish(save({ id, reason, report, ...context, location, storageAction }, { status: 'preparing' }));
  }
  function finish(id, context, run, record) {
    const previous = localReport(id);
    const pr = record.work?.readiness?.url;
    const outcome = String(record.status || run.status).replace(/[^a-z-]/g, '');
    const note =
      '\n\n## Progress checkpoint\n\n' +
      `Run \`${run.id}\` ended with status **${outcome}**.` +
      (typeof pr === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr)
        ? ` Code PR: ${pr}.`
        : '') +
      '\n';
    const report = withSharedProgress(previous, outcome).trimEnd() + note;
    copySharedIssueFile(join(root, '.issues', id + '.md'), report);
    checkpoint(id, 'Progress ended', context, report);
  }
  function retry(id) {
    requireThat(!active(id), 'Wait for the current run to stop before retrying publication.');
    const record = receipt(id);
    requireThat(
      record && ['failed', 'preparing', 'review'].includes(record.status),
      'There is no pending report to retry.'
    );
    return publicState(publish(record, true));
  }
  function handoff(id) {
    requireThat(!active(id), 'Stop the runner before handing off an issue.');
    const record = service.lifecycleRuns[id];
    const url = record?.work?.readiness?.url;
    requireThat(
      typeof url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url),
      'Publish the retained work as a code PR before handing it off.'
    );
    const current = localReport(id);
    const context = acquire({ id, content: current }, true);
    const report = withSharedProgress(current, 'handed-off').trimEnd() + `\n\n## Handoff\n\nRetained work: ${url}.\n`;
    copySharedIssueFile(join(root, '.issues', id + '.md'), report);
    return publicState(checkpoint(id, 'Explicit handoff', context, report));
  }
  function publishDraft(id) {
    requireThat(!active(id), 'Stop the runner before publishing a report update.');
    const content = localReport(id);
    requireThat(baseline(id) && baseline(id) !== digest(content), 'There is no unpublished report update.');
    const context = acquire({ id, content }, true);
    return publicState(checkpoint(id, 'Explicit report update', context, content));
  }
  function moveStorage(id, action, content) {
    const previous = receipt(id);
    if (previous?.storageAction === action && previous.status !== 'published')
      return previous.status === 'review'
        ? publicState(previous)
        : previous.status === 'claimed'
          ? recover(id)
          : retry(id);
    const live = publication.readTarget(id);
    if (action === 'archive' && live.report === null) return null;
    requireThat(action === 'restore' || live.location === 'closed', 'Close the shared issue before archiving it.');
    const context = acquire({ id, content }, false, action === 'restore');
    save(receipt(id), { storageAction: action });
    return saveStorageCheckpoint(id, action, content, context);
  }
  function saveStorageCheckpoint(id, action, content, context) {
    if (action === 'archive') {
      const archive = storedIssuePath(root, id, 'archive');
      mkdirSync(join(root, '.issues/archive'), { recursive: true });
      if (!existsSync(archive)) copyFileSync(storedIssuePath(root, id, 'closed'), archive, constants.COPYFILE_EXCL);
      requireThat(sameReport(id, 'archive', content), 'An archive copy already exists with different content.');
    }
    return publicState(
      checkpoint(
        id,
        action === 'archive' ? 'Archive closed report' : 'Restore closed report',
        context,
        action === 'archive' ? null : content,
        action === 'archive' ? null : 'closed',
        action
      )
    );
  }
  function storageStatus(id) {
    const record = receipt(id);
    return record?.storageAction ? publicState(record) : null;
  }
  function recover(id) {
    requireThat(!active(id), 'Wait for the current run to stop before reconciling its claim.');
    const claim = claims.own(id);
    requireThat(claim, 'This checkout has no claim to recover.');
    const saved = receipt(id);
    requireThat(!saved || ['published', 'claimed'].includes(saved.status), 'Resolve the pending report update first.');
    const live = publication.readTarget(id);
    if (!claims.verifyOwn(id)) {
      release(id, claim);
      if (saved?.status === 'claimed') save(saved, { status: 'published' });
      return { status: 'released' };
    }
    if (saved?.status === 'claimed' && saved.storageAction) {
      const action = saved.storageAction;
      requireThat(
        live.report === saved.base && live.location === saved.baseLocation,
        'The shared report changed before recovery.'
      );
      const source = action === 'archive' ? 'closed' : 'archive';
      return saveStorageCheckpoint(id, action, localReport(id, source), {
        claim,
        base: saved.base,
        baseLocation: saved.baseLocation,
      });
    }
    const base = saved?.status === 'claimed' ? saved.base : live.report;
    const location = saved?.baseLocation || live.location;
    requireThat(
      live.report !== null && live.report === base,
      'The claimed report changed on the target. Reconcile it before recovery.'
    );
    if (saved?.status !== 'claimed')
      requireThat(
        localReport(id, location) === live.report,
        'The interrupted claim has no saved base and the local report differs.'
      );
    const report =
      localReport(id, location).trimEnd() +
      '\n\n## Progress checkpoint\n\nAn interrupted run was reconciled by the operator.\n';
    copySharedIssueFile(storedIssuePath(root, id, location), report);
    return publicState(checkpoint(id, 'Interrupted run recovered', { claim, base, baseLocation: location }, report));
  }
  function confirm(id) {
    requireThat(!active(id), 'Stop the runner before confirming the reviewed merge.');
    const record = receipt(id);
    requireThat(
      record && ['failed', 'review', 'preparing'].includes(record.status),
      'There is no pending report to reconcile.'
    );
    const result = publication.confirmMerged(id);
    const live = publication.readTarget(id);
    const source = record.storageAction === 'restore' ? 'archive' : record.baseLocation || 'open';
    if (
      record.storageAction !== 'archive' &&
      sameReport(id, source, record.report) &&
      live.report !== null &&
      live.report !== record.report
    ) {
      copySharedIssueFile(storedIssuePath(root, id, source), live.report);
      save(record, { report: live.report });
    }
    return publicState(publishConfirmed(record, result));
  }
  function publicState(record) {
    return record ? { status: record.status, url: record.url, error: record.error } : null;
  }
  function view(id) {
    const own = claims.own(id);
    const pending = receipt(id);
    const running = active(id);
    const idle = !running && !own && !remoteClaims.has(id) && (!pending || pending.status === 'published');
    const location = existsSync(storedIssuePath(root, id, 'closed')) ? 'closed' : 'open';
    const base = baseline(id, location);
    return {
      claimed: Boolean(own || remoteClaims.has(id)),
      local: Boolean(own),
      active: running,
      published: Boolean(base),
      canHandoff: idle && Boolean(service.lifecycleRuns[id]?.work?.readiness?.url),
      canPublishDraft: idle && Boolean(base && base !== digest(localReport(id, location))),
      checkpoint: publicState(pending),
    };
  }
  return {
    acquire,
    checkpoint,
    finish,
    refresh,
    retry,
    recover,
    handoff,
    confirm,
    publishDraft,
    moveStorage,
    storageStatus,
    view,
  };
}
