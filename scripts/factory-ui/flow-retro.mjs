import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { writeDiscussionEvidence } from './discussion-evidence.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createDiscussionRuntime } from './discussion-codex.mjs';
import { parseRetroResult, retroSchema } from './issue-chat.mjs';
import { boundConversationThreads, conversationState } from './conversation-store.mjs';
import { conversationTimeline } from './conversation-view.mjs';
import { readQueue } from './data.mjs';
import { redactValue } from './activity.mjs';
import { digest, git, requireThat } from './common.mjs';
import { exportRetroThread, groupVerificationTurns, repairTurns } from './flow-retro-thread.mjs';
import { receiptRepairBrowserProof } from './flow-repair-evidence.mjs';
import { evidencePath } from './stores/evidence.mjs';
import { readFileSync } from 'node:fs';
import { groupClosureProof } from './flow-group-closure.mjs';

function closureSnapshot(root, issue, flow) {
  return flow.closing?.groupProof ?? groupClosureProof(root, issue, flow, flow.workspace?.checkout);
}

async function readThread(connection, id, signal, attempts) {
  try {
    const result = await Promise.race([
      connection.ready().then(() => connection.call('thread/read', { threadId: id, includeTurns: true })),
      delay(8000, null, { signal, ref: false }),
    ]);
    const thread = result?.thread;
    signal.throwIfAborted();
    return exportRetroThread(id, thread, attempts);
  } catch (error) {
    return exportRetroThread(id, null, attempts, redactValue(error.message));
  }
}

async function retroHistory(service, { issue, flow, signal }) {
  const queue = readQueue(service.root, { location: issue.location, issueId: issue.id });
  const report = queue.issues.find((entry) => entry.id === issue.id) ?? issue;
  const timeline = conversationTimeline(service, queue, report);
  const saved = conversationState(service.root, issue.id);
  const attempts = [...flow.blocks, ...(flow.retiredBlocks || [])]
    .filter((block) => block.kind !== 'retro')
    .flatMap((block) => block.attempts.map((attempt) => ({ block: block.label, kind: block.kind, ...attempt })))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const threadIds = new Set(
    [
      ...boundConversationThreads(saved),
      ...timeline.map((event) => event.source?.threadId),
      ...attempts.map((entry) => entry.result?.threadId),
      ...attempts.flatMap((entry) => repairTurns(entry).map(({ threadId }) => threadId)),
      ...attempts.flatMap((entry) => groupVerificationTurns(entry).map(({ threadId }) => threadId)),
    ].filter(Boolean)
  );
  const threads = await Promise.all([...threadIds].map((id) => readThread(service.codex, id, signal, attempts)));
  signal.throwIfAborted();
  return {
    report: issue.content,
    timeline,
    attempts,
    threads: threads.toSorted((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity)),
    groupClosure: closureSnapshot(service.root, issue, flow),
    coverage:
      'The report and histories available to this runner are included. Other runners may have local records this runner cannot see.',
  };
}

function retroEvidence(root, history) {
  const directory = join(root, '.issues/factory-ui/flow-evidence', 'retro-' + randomUUID());
  const safe = redactValue({
    ...history,
    repairs: exportRepairEvidence(root, directory, history.attempts),
    mergeRepairs: exportMergeRepairs(root, directory, history.attempts),
    deliveryReceipts: exportDeliveryReceipts(root, directory, history.attempts),
    groupVerifications: exportGroupVerifications(root, directory, history),
  });
  const sections = Object.fromEntries(
    [
      'report',
      'timeline',
      'attempts',
      'threads',
      'repairs',
      'mergeRepairs',
      'deliveryReceipts',
      'groupVerifications',
      'groupClosure',
    ].map((key) => [key, writeDiscussionEvidence(directory, key + '.json', JSON.stringify(safe[key], null, 2))])
  );
  const index = { sections, coverage: safe.coverage };
  return { index, reference: writeDiscussionEvidence(directory, 'index.json', JSON.stringify(index, null, 2)) };
}

function exportRepairEvidence(root, directory, attempts) {
  const files = attempts.flatMap(({ id, evidence }) =>
    (evidence ?? []).filter(({ repairTurn }) => repairTurn).map((file) => ({ id, file }))
  );
  return files.map(({ id, file }, index) => exportRepair(root, directory, id, file, index + 1));
}

function readRepairEvidence(root, { path, sha256 }) {
  const bytes = readFileSync(evidencePath(root, path, sha256));
  requireThat(digest(bytes) === sha256, 'The retained repair evidence digest changed.');
  return bytes;
}

function exportDeliveryReceipts(root, directory, attempts) {
  return attempts
    .filter(({ kind, result }) => kind === 'merge' && result?.revision)
    .filter(({ result }) => result.deliveryReceipt)
    .map(({ id, result }, index) => exportDeliveryReceipt(root, directory, id, result.deliveryReceipt, index + 1));
}

function exportDeliveryReceipt(root, directory, attemptId, file, position) {
  const prefix = 'delivery-' + position;
  try {
    const bytes = readRepairEvidence(root, file);
    const { candidate } = JSON.parse(bytes);
    const receipt = writeDiscussionEvidence(directory, prefix + '-receipt.json', bytes);
    const proof = receiptRepairBrowserProof(root, file, candidate);
    const repairBrowserProof = proof && {
      ...proof,
      file: exportRepairAttachment(root, directory, proof.file, prefix + '-repair-browser.json'),
    };
    return { attemptId, receipt, candidate, repairBrowserProof };
  } catch (error) {
    return { attemptId, receipt: { sha256: file.sha256, unavailable: error.message } };
  }
}

function exportMergeRepairs(root, directory, attempts) {
  const indexes = attempts.flatMap(({ evidence = [] }) =>
    evidence.filter(({ label }) => label === 'Merge repair index')
  );
  return indexes.map((file, index) => exportMergeRepair(root, directory, file, index + 1));
}

function exportMergeRepair(root, directory, file, repairIndex) {
  try {
    const { attemptId, attempts, delivery } = JSON.parse(readRepairEvidence(root, file));
    const saved = new Map();
    const copy = (source) => {
      if (!saved.has(source.path)) {
        const name = `merge-repair-${repairIndex}-attachment-${saved.size + 1}.log`;
        saved.set(source.path, exportRepairAttachment(root, directory, source, name));
      }
      return saved.get(source.path);
    };
    return { attemptId, delivery, attempts: attempts.map((entry) => exportRepairAttempt(entry, copy)) };
  } catch (error) {
    return { sha256: file.sha256, unavailable: error.message };
  }
}

function exportRepairAttempt({ result, log, failure, ...attempt }, copy) {
  return {
    ...attempt,
    log: log && copy(log),
    failure: {
      ...failure,
      evidence: failure.evidence?.map(copy),
      checks: failure.checks?.map((check) => ({ ...check, log: check.log && copy(check.log) })),
    },
  };
}

function exportRepairAttachment(root, directory, file, name) {
  try {
    return writeDiscussionEvidence(directory, name, readRepairEvidence(root, file));
  } catch (error) {
    return { sha256: file.sha256, unavailable: error.message };
  }
}

function workGroupProof({ artifacts }) {
  return artifacts?.files?.subIssueProof;
}

function exportGroupVerifications(root, directory, { attempts, threads }) {
  const operations = attempts
    .filter(({ kind }) => ['merge', 'close'].includes(kind))
    .map(({ id, kind, status, result }) => ({
      id,
      kind,
      status,
      head: result?.head,
      revision: result?.revision,
      candidate: result?.groupProof?.candidate,
    }));
  return attempts.flatMap((attempt, index) => {
    const prefix = 'group-verification-' + (index + 1);
    const files = (attempt.evidence ?? []).filter(({ groupVerification }) => groupVerification);
    const records = files.map((file, position) =>
      exportIndexedVerification(root, directory, attempt.id, file, prefix + '-' + (position + 1), operations)
    );
    if (workGroupProof(attempt))
      records.push(exportWorkVerification(root, directory, attempt, prefix, threads, operations));
    if (!files.length)
      records.push(...exportLegacyVerifications(root, directory, attempt, prefix, threads, operations));
    return records;
  });
}

function legacyProofHead(path) {
  return /^group-proof-([0-9a-f]{40,64})$/.exec(basename(dirname(path)))?.[1];
}

function legacyResponseMatches(item, sha256) {
  return item.type === 'agentMessage' && typeof item.text === 'string' && digest(item.text) === sha256;
}

function legacyTurn(threads, response) {
  if (!response?.sha256) return {};
  const matches = threads.flatMap(({ id, turns = [] }) =>
    turns
      .filter(({ items }) => items.some((item) => legacyResponseMatches(item, response.sha256)))
      .map((turn) => ({ threadId: id, turnId: turn.id }))
  );
  return matches.length === 1 ? matches[0] : {};
}

function legacyTree(root, head) {
  try {
    return git(root, 'rev-parse', '--verify', head + '^{tree}');
  } catch {
    return undefined;
  }
}

function exportLegacyVerifications(root, directory, attempt, prefix, threads, operations) {
  const evidence = attempt.evidence ?? [];
  const files = evidence.filter(
    ({ path = '' }) => basename(path).startsWith('artifact-subIssueProof-') && legacyProofHead(path)
  );
  return files.map((file, index) => {
    const matching = evidence.filter(({ path = '' }) => dirname(path) === dirname(file.path));
    return exportLegacyVerification(root, directory, file, matching, prefix + '-legacy-' + (index + 1), threads, {
      attemptId: attempt.id,
      operations,
    });
  });
}

function exportLegacyVerification(root, directory, file, matching, prefix, threads, linked) {
  const head = legacyProofHead(file.path);
  const response = matching.find(({ path }) => basename(path) === 'output.txt');
  const logs = matching.filter(({ path }) => basename(path).startsWith('artifact-log-'));
  return {
    ...linked,
    ...legacyTurn(threads, response),
    head,
    tree: legacyTree(root, head),
    proof: exportRepairAttachment(root, directory, file, prefix + '-proof.json'),
    logs: logs.map((log, index) => exportRepairAttachment(root, directory, log, `${prefix}-command-${index + 1}.log`)),
  };
}

function exportIndexedVerification(root, directory, attemptId, file, prefix, operations) {
  const linked = { attemptId, ...file.groupVerification, operations };
  try {
    const { proof, logs } = JSON.parse(readRepairEvidence(root, file));
    return {
      ...linked,
      proof: proof && exportRepairAttachment(root, directory, proof, prefix + '-proof.json'),
      logs: logs.map((log, position) => ({
        command: log.command,
        ...exportRepairAttachment(root, directory, log, `${prefix}-command-${position + 1}.log`),
      })),
    };
  } catch (error) {
    return { ...linked, unavailable: error.message };
  }
}

function findProofTurn(threads, { threadId, turnId }) {
  const thread = threads.find(({ id }) => id === threadId);
  return thread?.turns?.find(({ id }) => id === turnId);
}

function exportTurnLogs(directory, prefix, items = []) {
  return items
    .filter(({ type, command }) => type === 'commandExecution' && command)
    .map(({ command, aggregatedOutput, exitCode, status }, index) => ({
      command,
      status,
      exitCode,
      ...(typeof aggregatedOutput === 'string'
        ? writeDiscussionEvidence(directory, `${prefix}-command-${index + 1}.log`, redactValue(aggregatedOutput))
        : { unavailable: 'The provider did not return command output.' }),
    }));
}

function workVerificationLogs(root, directory, attempt, turn, prefix) {
  const logs = exportTurnLogs(directory, prefix, turn.items);
  const savedLog = attempt.artifacts?.files?.log;
  if (savedLog) logs.push(exportRepairAttachment(root, directory, savedLog, prefix + '-retained.log'));
  return logs;
}

function exportWorkVerification(root, directory, attempt, prefix, threads, operations) {
  const { threadId, turnId, head, tree } = attempt.result ?? {};
  const turn = findProofTurn(threads, { threadId, turnId }) ?? {};
  const proof = exportRepairAttachment(root, directory, workGroupProof(attempt), prefix + '-proof.json');
  return {
    attemptId: attempt.id,
    threadId,
    turnId,
    head,
    tree,
    proof,
    logs: workVerificationLogs(root, directory, attempt, turn, prefix),
    operations,
    ...(turn.id ? {} : { logsUnavailable: 'The original proof turn is unavailable.' }),
  };
}

function exportRepair(root, directory, attemptId, file, repairIndex) {
  const linked = { attemptId, ...file.repairTurn };
  try {
    const { logs } = JSON.parse(readRepairEvidence(root, file));
    return {
      ...linked,
      logs: logs.map((log, index) =>
        exportRepairAttachment(root, directory, log, `repair-${repairIndex}-command-${index + 1}.log`)
      ),
    };
  } catch (error) {
    return { ...linked, unavailable: error.message };
  }
}

export async function runRetro(service, ctx, create = createDiscussionRuntime) {
  const session = create(undefined, { root: service.root, model: ctx.attempt?.modelSettings?.model });
  const evidence = [];
  const progress = (text) => ctx.onProgress?.(text + '\n', true);
  let phase = 'collecting issue history';
  let timer;
  let abort;
  let ended = false;
  try {
    const expired = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(Error(`Retro timed out while ${phase}. The issue history is still available for a retry.`), {
              evidence,
            })
          ),
        5 * 60_000
      );
      abort = () => reject(ctx.signal.reason);
      ctx.signal.addEventListener('abort', abort, { once: true });
    });
    const review = async () => {
      progress('Collecting issue history for Retro.');
      const history = await retroHistory(service, ctx);
      requireThat(!ended, 'The Retro attempt ended before the history was ready.');
      const { index, reference } = retroEvidence(service.root, history);
      evidence.push({ ...reference, key: 'retro-input', label: 'Complete retro input evidence' });
      phase = 'starting the review session';
      progress('Starting the Retro review session.');
      await session.begin(
        {
          task: 'Run an issue retrospective.',
          issueCheckout: ctx.flow.workspace?.checkout,
          evidence: reference,
        },
        [
          ctx.definition.prompt,
          'Use the issue report, timeline, attempts, and linked Codex turns as evidence. Preserve order within each thread. Use recorded repair attempt and turn IDs to link repairs before using timestamps for other events. State missing history and unclear ordering.',
          'The evidence index links to the report, timeline, attempts, linked Codex turns, repair command logs, merge repair revisions, CI runs and failure attachments, delivery receipts with matching repair browser proof, group verification history, and the child proof snapshot from Close. Search and read relevant ranges across the history, including earlier attempts. Inspect relevant project files and recent Git work when useful. Cite evidence paths/revisions, distinguish observations from claims, and state which evidence was unavailable or not inspected.',
          'Return a concise summary and concrete follow-up issues. An empty recommendation list is valid. Do not claim model descriptions prove actual checks, merge or acceptance.',
        ].join('\n\n')
      );
      if (ended) return;
      ctx.signal.throwIfAborted();
      phase = 'reviewing issue history';
      progress('Reviewing the issue history.');
      return session.ask(JSON.stringify(index), [], retroSchema);
    };
    ctx.signal.throwIfAborted();
    const result = parseRetroResult(await Promise.race([expired, review()]));
    requireThat(
      result.recommendations.length <= 12 &&
        result.recommendations.every((item) =>
          ['title', 'description', 'reason', 'verification'].every(
            (key) => typeof item?.[key] === 'string' && item[key].trim()
          )
        ),
      'Retro returned invalid follow-up issues.'
    );
    return {
      evidence,
      summary: redactValue(result.summary),
      recommendations: result.recommendations.map((item) => ({ ...redactValue(item), requestId: randomUUID() })),
    };
  } finally {
    ended = true;
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', abort);
    session.close();
  }
}
