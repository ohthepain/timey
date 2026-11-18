import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { git, requireThat } from './common.mjs';
import { readProgress } from '../factory-progress.mjs';
import { listStoredIssues } from './issue-report-storage.mjs';
import { redactValue } from './activity.mjs';

const maxMessages = 4000;
const maxBytes = 1500000;
const regular = (path) => lstatSync(path, { throwIfNoEntry: false })?.isFile();

function subtractMonths(date, count) {
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - count);
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, end.getUTCDate()));
}

export function automateHistoryWindow(value = 4, unit = 'weeks', now = new Date()) {
  requireThat(Number.isInteger(value) && value > 0 && value <= 10000, 'Choose a duration from 1 to 10000.');
  requireThat(['days', 'weeks', 'months'].includes(unit), 'Choose days, weeks, or months.');
  const since = new Date(now);
  const subtract = {
    months: () => subtractMonths(since, value),
    weeks: () => since.setUTCDate(since.getUTCDate() - value * 7),
    days: () => since.setUTCDate(since.getUTCDate() - value),
  };
  subtract[unit]();
  return { since: since.toISOString(), until: now.toISOString(), durationValue: value, durationUnit: unit };
}

function commonDirectory(root) {
  return realpathSync(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
}

function projectMatches(root, cwd) {
  try {
    return commonDirectory(root) === commonDirectory(cwd);
  } catch {
    return false;
  }
}

function scopedPath(base, path) {
  let current = realpathSync(base);
  for (const part of relative(base, path).split(sep).filter(Boolean)) {
    requireThat(part !== '..', 'History paths must stay within their project checkout.');
    current = join(current, part);
    requireThat(
      !lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink(),
      'A saved history path uses a symlink and was excluded.'
    );
  }
  return current;
}

function directories(base, path) {
  scopedPath(base, path);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[\w-]{1,100}$/.test(entry.name))
    .map((entry) => entry.name);
}

function readRecord(base, path) {
  scopedPath(base, path);
  if (!regular(path)) return null;
  requireThat(lstatSync(path).size <= 8000000, 'A saved conversation record exceeds the history limit.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function captureThreadIds(state, ids) {
  const value = state || {};
  const blocks = Object.values(value.flowBlocks || {});
  [value.threadId, ...blocks.map((block) => block.threadId)].filter(Boolean).forEach((id) => ids.add(id));
}

function savedCheckout(record) {
  return record.work?.checkout || record.chatCheckout?.checkout;
}

function conversationPaths(root, id, record, gaps) {
  const paths = [{ base: root, path: join(root, '.issues/conversations', id) }];
  const checkout = savedCheckout(record);
  if (!checkout) return paths;
  if (projectMatches(root, checkout)) paths.push({ base: checkout, path: join(checkout, '.issues/conversations', id) });
  else gaps.add(`Issue ${id}: its saved runner checkout is unavailable.`);
  return paths;
}

function legacyRole(item) {
  return ['human', 'user'].includes(item.kind) || item.role === 'You' ? 'user' : 'assistant';
}

function localRole(item) {
  return { human: 'user', factory: 'factory', agent: 'assistant' }[item.actor] || legacyRole(item);
}

function localMessage(item, id) {
  return { id: item.id, at: item.at, role: localRole(item), text: item.body, source: `Issue ${id} conversation` };
}

function readMessages(base, path, id) {
  const log = scopedPath(base, join(path, 'messages.jsonl'));
  if (!regular(log)) return [];
  requireThat(lstatSync(log).size <= 8000000, 'The conversation exceeds the history size limit.');
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((item) => typeof item.body === 'string')
    .map((item) => localMessage(item, id));
}

function readConversation({ base, path }, id, threads, gaps) {
  try {
    captureThreadIds(readRecord(base, join(path, 'chat.json')), threads);
    return readMessages(base, path, id);
  } catch {
    gaps.add(`Issue ${id}: some saved conversation history could not be read.`);
    return [];
  }
}

function flowAttempts(flow) {
  const value = flow || {};
  return [...(value.blocks || []), ...(value.retiredBlocks || [])].flatMap((block) => block.attempts || []);
}

function attemptThreads(attempt) {
  return [attempt.threadId, attempt.result?.threadId].filter(Boolean);
}

function readFlowThreads(root, id, threads, gaps) {
  try {
    const flow = readRecord(root, join(root, '.issues/flows', id, 'flow.json'));
    flowAttempts(flow)
      .flatMap(attemptThreads)
      .forEach((thread) => threads.add(thread));
  } catch {
    gaps.add(`Issue ${id}: saved flow history could not be read.`);
  }
}

function issueIds(root) {
  const reports = ['open', 'closed', 'archive'].flatMap((location) =>
    listStoredIssues(root, location).map((path) => basename(path, '.md'))
  );
  return new Set([
    ...reports,
    ...directories(root, join(root, '.issues/conversations')),
    ...directories(root, join(root, '.issues/flows')),
  ]);
}

function savedIssueHistory(service, gaps) {
  const root = service.root;
  const progress = readProgress(root);
  const threads = new Set();
  const messages = [...issueIds(root)].flatMap((id) => {
    const record = progress[id] || {};
    captureThreadIds(record.nativeChat, threads);
    readFlowThreads(root, id, threads, gaps);
    return conversationPaths(root, id, record, gaps).flatMap((path) => readConversation(path, id, threads, gaps));
  });
  for (const run of service.store?.runs || [])
    captureThreadIds({ threadId: run.threadId, flowBlocks: { worker: { threadId: run.workerThreadId } } }, threads);
  return { messages, threads };
}

function projectWorktrees(root) {
  return [
    ...new Set(
      git(root, 'worktree', 'list', '--porcelain', '-z')
        .split('\0')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice(9))
    ),
  ];
}

function itemText(item) {
  if (item.type === 'agentMessage') return item.text;
  if (item.type !== 'userMessage') return null;
  return (item.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function timestamp(value) {
  if (typeof value !== 'number') return value;
  return new Date(value < 100000000000 ? value * 1000 : value).toISOString();
}

function threadMessages(thread) {
  return thread.turns.flatMap((turn) =>
    (turn.items || [])
      .map((item) => ({
        id: `${thread.id}:${turn.id}:${item.id}`,
        at: timestamp(turn.startedAt),
        role: item.type === 'userMessage' ? 'user' : 'assistant',
        text: itemText(item),
        source: `Codex ${thread.id}`,
      }))
      .filter((item) => item.text)
  );
}

class NativeHistory {
  constructor(service, threads, window, signal, gaps) {
    Object.assign(this, {
      service,
      threads,
      window,
      signal,
      gaps,
      connection: service.codex,
      worktrees: projectWorktrees(service.root),
    });
  }

  includeThread(thread) {
    if (timestamp(thread.updatedAt) < this.window.since) return;
    if (projectMatches(this.service.root, thread.cwd)) this.threads.add(thread.id);
  }

  async discover(archived) {
    let cursor;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page = await this.connection.call('thread/list', {
        limit: 100,
        useStateDbOnly: true,
        archived,
        cwd: this.worktrees,
        sortKey: 'updated_at',
        ...(cursor ? { cursor } : {}),
      });
      this.signal.throwIfAborted();
      requireThat(Array.isArray(page.data), 'Native discovery returned invalid chat metadata.');
      page.data.forEach((thread) => this.includeThread(thread));
      cursor = page.nextCursor;
      if (!cursor) return;
    }
    this.gaps.add('Native chat discovery reached its page limit; older chats may be missing.');
  }

  async discoverAvailable() {
    try {
      await this.connection.ready();
      this.signal.throwIfAborted();
      await this.discover(false);
      await this.discover(true);
    } catch {
      this.signal.throwIfAborted();
      this.gaps.add('Native chat discovery was unavailable; known project chat references were still checked.');
    }
  }

  async readThread(id) {
    this.signal.throwIfAborted();
    try {
      const { thread } = await this.connection.call('thread/read', { threadId: id, includeTurns: true });
      this.signal.throwIfAborted();
      requireThat(projectMatches(this.service.root, thread.cwd), 'Foreign project reference.');
      requireThat(Array.isArray(thread.turns), 'Missing turns.');
      return threadMessages({ ...thread, id });
    } catch {
      this.signal.throwIfAborted();
      this.gaps.add(`Native chat ${id}: its project history is unavailable on this runner.`);
      return [];
    }
  }

  async read() {
    if (!this.connection) {
      this.gaps.add('Native Codex history is unavailable on this runner.');
      return [];
    }
    await this.discoverAvailable();
    const messages = [];
    for (const id of [...this.threads].slice(0, 200)) messages.push(...(await this.readThread(id)));
    if (this.threads.size > 200) this.gaps.add('Native history reached its 200-chat limit.');
    return messages;
  }
}

function normalizedMessage(item, window, gaps) {
  if (!Number.isFinite(Date.parse(item.at))) {
    gaps.add('Messages without a retained timestamp were excluded from the selected duration.');
    return null;
  }
  const at = new Date(item.at).toISOString();
  if (at < window.since || at > window.until) return null;
  return redactValue({ ...item, at });
}

function uniqueMessages(messages, window, gaps) {
  const unique = new Map();
  messages
    .map((item) => normalizedMessage(item, window, gaps))
    .filter(Boolean)
    .forEach((item) => unique.set(`${item.at}:${item.role}:${item.text}`, item));
  return [...unique.values()].sort((a, b) => a.at.localeCompare(b.at));
}

function boundedMessages(messages) {
  let bytes = 0;
  const retained = [];
  for (const item of messages.toReversed()) {
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (retained.length >= maxMessages || bytes > maxBytes) break;
    retained.push(item);
  }
  return retained.reverse();
}

export async function collectAutomateHistory(service, window, signal) {
  const gaps = new Set([
    'History includes records available to this runner. Other machines may retain additional conversations.',
  ]);
  const local = savedIssueHistory(service, gaps);
  const native = await new NativeHistory(service, local.threads, window, signal, gaps).read();
  signal.throwIfAborted();
  const ordered = uniqueMessages([...local.messages, ...native], window, gaps);
  const retained = boundedMessages(ordered);
  const truncated = retained.length < ordered.length;
  if (truncated) gaps.add('History exceeded the input limit. Only the most recent messages were retained.');
  return {
    messages: retained,
    coverage: { ...window, messageCount: retained.length, threadCount: local.threads.size, gaps: [...gaps], truncated },
  };
}
