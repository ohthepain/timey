import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readQueue } from './data.mjs';
import { digest, requireThat, writeJson } from './common.mjs';
import { appendCompletion } from '../factory-completion.mjs';

const execute = promisify(execFile);
const applications = {
  chrome: 'Google Chrome',
  brave: 'Brave Browser',
  safari: 'Safari',
  firefox: 'Firefox',
  edge: 'Microsoft Edge',
};
function browserChoices() {
  const choices = [{ id: 'current', label: 'ChatGPT / this browser' }];
  if (process.platform !== 'darwin') return choices;
  choices.push({ id: 'default', label: 'Default browser' });
  for (const [id, name] of Object.entries(applications))
    if (['/Applications', join(homedir(), 'Applications')].some((root) => existsSync(join(root, name + '.app'))))
      choices.push({ id, label: name });
  return choices;
}
async function openBrowser(browser, url) {
  if (browser === 'current') return;
  const args = browser === 'default' ? [url] : ['-a', applications[browser], url];
  await execute('/usr/bin/open', args);
}
function completedPrototype(issue, check) {
  return (
    check.status === 'passed' && Boolean(issue.prototype_preview) && check.revision === issue.prototype_preview.revision
  );
}
function targetVersion(target) {
  return target && typeof target.revision === 'string' && target.revision;
}
function httpTarget(target) {
  try {
    const url = new URL(target.url);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username + url.password) return null;
    return { url: url.href, revision: target.revision };
  } catch {
    return null;
  }
}
function excludedReview(issue, check) {
  return check.blocks === 'closure' || completedPrototype(issue, check);
}
function reviewTarget(issue, check) {
  if (excludedReview(issue, check)) return null;
  const target = check.review_target || issue.implementation_preview;
  return targetVersion(target) ? httpTarget(target) : null;
}
function completedReview(check, target) {
  return check.status === 'passed' && check.revision === target.revision;
}
function currentOpening(receipt, basis) {
  return receipt?.basis === basis ? receipt : null;
}
function validateFeedback(input) {
  requireThat(['passed', 'failed'].includes(input.status), 'Choose Approve result or Needs changes.');
  requireThat(
    typeof input.result === 'string' && input.result.trim() && input.result.length <= 4000,
    'Describe the review result in under 4,000 characters.'
  );
}
function validateOpening(receipt, basis, token) {
  requireThat(receipt?.basis === basis && receipt.token === token, 'Open this site before recording your review.');
}
function resultSummary(status) {
  return status === 'passed' ? 'Site review approved.' : 'Site review needs changes.';
}
function reviewBasis(queue, issue, check, target) {
  return digest(
    JSON.stringify({
      report: issue.content,
      check: check.id,
      target,
      head: queue.head,
      worktree: queue.snapshot.worktree,
    })
  );
}
function eligible(queue, issue) {
  return queue.lifecycle.some((stage) => stage.state === issue.state && stage.role === 'ready-to-verify');
}
export function createSiteReviews(service, launch = openBrowser, choices = browserChoices) {
  const opened = new Map();
  const key = (owner, issue, check) => JSON.stringify([owner, issue, check]);
  function context(input) {
    const queue = readQueue(service.root),
      issue = queue.issues.find((item) => item.id === input.issueId);
    requireThat(issue && eligible(queue, issue), 'Open the current Verify step before reviewing a site.');
    const check = issue.human_checks?.find((item) => item.id === input.checkId);
    requireThat(check, 'This review no longer exists.');
    const target = reviewTarget(issue, check);
    requireThat(target, 'This review needs a current HTTP(S) site and candidate revision.');
    const basis = reviewBasis(queue, issue, check, target);
    requireThat(input.basis === basis, 'The issue or review target changed. Refresh and open the site again.');
    return { queue, issue, check, target, basis };
  }
  return {
    view(queue, issue, owner) {
      if (!eligible(queue, issue)) return null;
      const checks = (issue.human_checks || []).flatMap((check) => {
        const target = reviewTarget(issue, check);
        if (!target) return [];
        const basis = reviewBasis(queue, issue, check, target),
          receipt = opened.get(key(owner, issue.id, check.id));
        return [
          {
            id: check.id,
            instructions: check.instructions,
            kind: check.kind,
            status: check.status,
            result: check.result,
            ...target,
            basis,
            opened: currentOpening(receipt, basis),
            completed: completedReview(check, target),
          },
        ];
      });
      return { browsers: choices(), checks, mode: service.reviewMode || 'live' };
    },
    async open(input, owner) {
      const before = context(input);
      requireThat(
        choices().some((choice) => choice.id === input.browser),
        'Choose an available browser.'
      );
      await launch(input.browser, before.target.url);
      const current = context(input);
      const receipt = {
        token: randomUUID(),
        basis: current.basis,
        url: current.target.url,
        revision: current.target.revision,
        browser: input.browser,
        at: new Date().toISOString(),
      };
      opened.set(key(owner, current.issue.id, current.check.id), receipt);
      return receipt;
    },
    decide(input, owner) {
      requireThat(service.reviewMode !== 'preview', 'This is a preview copy. Record your approval on the real issue.');
      const { queue, issue, check, target, basis } = context(input);
      const identity = key(owner, issue.id, check.id),
        receipt = opened.get(identity);
      validateOpening(receipt, basis, input.token);
      validateFeedback(input);
      service.ownServer();
      requireThat(
        !existsSync(join(service.root, '.issues/factory-integration.lock')),
        'Wait for the active integration before recording.'
      );
      requireThat(!service.lifecycleTasks.has(issue.id), 'Wait for this issue’s current work before recording.');
      mkdirSync(service.store.directory, { recursive: true });
      const path = join(service.store.directory, 'site-review-' + randomUUID() + '.json');
      writeJson(path, {
        actor: 'human',
        project: service.root,
        mode: service.reviewMode || 'live',
        issueId: issue.id,
        checkId: check.id,
        status: input.status,
        result: input.result,
        target,
        opened: receipt,
        at: new Date().toISOString(),
      });
      appendCompletion(
        service.root,
        issue,
        {
          summary: resultSummary(input.status),
          notes: input.result,
          remaining: ['Technical verification, integration and final acceptance remain separate.'],
          human_check_update: {
            ...check,
            status: input.status,
            revision: target.revision,
            result: input.result,
            evidence_refs: [path],
          },
        },
        { base: target.revision, authorization: { kind: 'direct-user', operation: 'site-review' } },
        [{ path, sha256: digest(readFileSync(path)) }],
        null
      );
      opened.delete(identity);
      return { recorded: true, status: input.status };
    },
  };
}
