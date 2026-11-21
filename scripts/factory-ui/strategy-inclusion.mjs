import { git } from './common.mjs';

export function inspectPriorIssueInclusion(work, target) {
  const base = git(work.checkout, 'rev-parse', work.base);
  const head = git(work.checkout, 'rev-parse', 'HEAD');
  const targetRevision = git(work.checkout, 'rev-parse', target);
  const mergeBase = git(work.checkout, 'merge-base', targetRevision, base);
  const prMergeBase = git(work.checkout, 'merge-base', targetRevision, head);
  const commits = git(work.checkout, 'rev-list', '--reverse', `${targetRevision}..${base}`)
    .split('\n')
    .filter(Boolean)
    .map((revision) => commitDetails(work.checkout, revision));
  const targetCommits = listCommits(work.checkout, `${base}..${targetRevision}`);
  const repairCommits = repairRevisions(work).flatMap((range) => listCommits(work.checkout, range));
  const repairRevisionsSet = new Set(repairCommits.map((commit) => commit.revision));
  const issueCommits = listCommits(work.checkout, `${targetRevision}..${head}`).filter(
    (commit) => !repairRevisionsSet.has(commit.revision)
  );
  const files = changedFiles(work.checkout, prMergeBase, head);
  const targetFiles = changedFiles(work.checkout, base, targetRevision);
  return {
    branch: git(work.checkout, 'branch', '--show-current'),
    checkout: work.checkout,
    base,
    head,
    target: targetRevision,
    mergeBase,
    commits,
    files,
    pullRequest: { base: targetRevision, head, mergeBase: prMergeBase, files },
    targetUpdates: { commits: targetCommits, files: targetFiles },
    issueWork: { commits: issueCommits },
    repairs: { commits: repairCommits },
  };
}

function listCommits(root, range) {
  return git(root, 'rev-list', '--reverse', range)
    .split('\n')
    .filter(Boolean)
    .map((revision) => commitDetails(root, revision));
}

function commitDetails(root, revision) {
  return {
    revision,
    subject: git(root, 'show', '-s', '--format=%s', revision),
    files: git(root, 'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-m', revision)
      .split('\n')
      .filter(Boolean),
  };
}

function changedFiles(root, from, to) {
  return git(root, 'diff', '--name-status', from, to).split('\n').filter(Boolean);
}

function describeCommits(commits) {
  return (
    commits
      .map(({ revision, subject, files }) => `${revision} ${subject} [${files.join(', ') || 'no files'}]`)
      .join('; ') || '(none)'
  );
}

function repairRevisions(work) {
  return (work.repairs || []).flatMap((blocker) =>
    blocker.attempts.flatMap(({ before, after }) => (before && after ? [`${before}..${after}`] : []))
  );
}

export function intentionalInclusion(instruction, commits) {
  if (!commits.length) return { approved: true, reasons: [] };
  const expected = new Set(commits.map(({ revision }) => revision.toLowerCase()));
  const reasons = parseInclusionReasons(instruction);
  const approved = reasons.length === expected.size && reasons.every(({ revision }) => expected.delete(revision));
  return { approved, reasons: approved ? reasons : [] };
}

function parseInclusionReasons(instruction) {
  return String(instruction || '')
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*Include commit ([a-f0-9]{40}) intentionally:\s*(.{12,})\s*$/i);
      return match ? [{ revision: match[1].toLowerCase(), reason: match[2].trim() }] : [];
    });
}

export function inclusionPrompt(report, phase, evidencePath) {
  const details = report.commits
    .map(({ revision, subject, files }) => `- ${revision} ${subject}\n  ${files.join(', ') || '(no file list)'}`)
    .join('\n');
  const commitLines = report.commits
    .map(({ revision }) => `Include commit ${revision} intentionally: <why this is required by this issue>.`)
    .join('\n');
  return [
    `Cross-issue inclusion check stopped before ${phase}.`,
    `Issue branch: ${report.branch}; checkout: ${report.checkout}; starting commit: ${report.base}; target: ${report.target}; checkout HEAD: ${report.head}.`,
    'These commits are in the issue branch starting point but are not in the configured target:',
    details,
    `PR comparison: base ${report.pullRequest.base}, head ${report.pullRequest.head}, merge base ${report.pullRequest.mergeBase}.`,
    `PR changed paths: ${report.pullRequest.files.join(', ') || '(none)'}.`,
    `Target updates: ${describeCommits(report.targetUpdates.commits)}; paths since original base: ${report.targetUpdates.files.join(', ') || '(none)'}.`,
    `Issue work: ${describeCommits(report.issueWork.commits)}.`,
    `Repairs: ${describeCommits(report.repairs.commits)}.`,
    'This may be intentional. To include the listed commits, add one instruction line for each exact full SHA, followed by a reason. To keep the work separate, stop here and leave the checkout unchanged for reconciliation. No commit, file or comparison base was discarded or rewritten.',
    commitLines,
    `Evidence: ${evidencePath}`,
  ].join('\n');
}
