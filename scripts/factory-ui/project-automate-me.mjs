import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { digest, requireThat, writeJson } from './common.mjs';
import { redactValue } from './activity.mjs';
import { automateHistoryWindow, collectAutomateHistory } from './project-automate-history.mjs';
import { AutomateProvider } from './project-automate-provider.mjs';
import { initializeFolderSettings, readFolderSettings, updateFolderSettings } from './issue-folder-settings.mjs';

const activeStatuses = new Set(['running', 'stopping']);
const safeName = /^[a-z][a-z0-9-]{0,70}-mode$/;
const bundledModes = new Set(['poteto-mode']);
const stat = (path) => lstatSync(path, { throwIfNoEntry: false });

function checkedDirectory(path, create) {
  if (!stat(path) && create) mkdirSync(path, { mode: 0o700 });
  const item = stat(path);
  requireThat(!item || item.isDirectory(), 'Use an ordinary skill folder without symlinks.');
  return path;
}

function safeDirectory(base, parts, create = false) {
  return parts.reduce((path, part) => checkedDirectory(join(path, part), create), realpathSync(base));
}

function skillContent(path) {
  const item = stat(path);
  requireThat(!item || (item.isFile() && item.size <= 128000), 'The skill must be a regular file under 128 KB.');
  return item ? readFileSync(path, 'utf8') : null;
}

function draftMetadata(name, content) {
  requireThat(typeof name === 'string' && safeName.test(name), 'Choose a lowercase skill name ending in -mode.');
  requireThat(!bundledModes.has(name), 'Choose a personal skill name instead of replacing a bundled mode skill.');
  requireThat(typeof content === 'string' && content.trim(), 'Provide a skill draft.');
  requireThat(Buffer.byteLength(content) <= 64000, 'Provide a skill draft under 64 KB.');
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  requireThat(header, 'The skill needs YAML frontmatter.');
  return parse(header[1], { maxAliasCount: 0 });
}

function validateDraft(name, content) {
  const metadata = draftMetadata(name, content);
  requireThat(metadata?.name === name, 'The frontmatter name must match the reviewed skill name.');
  requireThat(
    typeof metadata.description === 'string' && metadata.description.trim(),
    'The skill needs a description.'
  );
  requireThat(
    metadata['disable-model-invocation'] === true,
    'Keep disable-model-invocation: true. Activation is a separate explicit choice.'
  );
}

function sessionId(value) {
  requireThat(typeof value === 'string' && /^[\w-]{1,100}$/.test(value), 'Choose a valid Automate me session.');
  return value;
}

function requestedDestination(value = 'project') {
  requireThat(['project', 'personal'].includes(value), 'Choose project or personal skill storage.');
  return value;
}

function existingModePaths(base, parts, depth = 0) {
  const directory = safeDirectory(base, parts);
  if (!existsSync(directory) || depth > 3) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(directory, entry.name, 'SKILL.md');
      if (safeName.test(entry.name) && !bundledModes.has(entry.name) && stat(path)?.isFile())
        return [{ name: entry.name, parts: [...parts, entry.name], path }];
      return existingModePaths(base, [...parts, entry.name], depth + 1);
    });
}

function windowRequest(input, now) {
  return automateHistoryWindow(input.durationValue ?? 4, input.durationUnit ?? 'weeks', now);
}

function responseFields(value) {
  const result = typeof value === 'string' ? JSON.parse(value) : value;
  requireThat(result && typeof result.message === 'string', 'Automate me returned an invalid response.');
  requireThat(result.message.length <= 64000, 'Automate me returned an oversized response.');
  return result;
}

function parseResponse(value) {
  const result = responseFields(value);
  if (result.draft) validateDraft(result.draft.name, result.draft.content);
  return redactValue(result);
}

function saveSkillDraft(path, draft) {
  requireThat(
    skillContent(path) === draft.currentContent,
    'The existing skill changed since review. Preview its current contents before applying.'
  );
  const temp = join(dirname(path), '.timey-' + randomUUID() + '.tmp');
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, draft.content);
  } finally {
    closeSync(fd);
  }
  try {
    requireThat(
      skillContent(path) === draft.currentContent,
      'The existing skill changed during Apply. Review it again.'
    );
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function requireReviewedInput(session, input) {
  requireThat(typeof input.activate === 'boolean', 'Choose explicitly whether to activate the skill.');
  const draft = session.draft;
  requireThat(draft && draft.basis === input.basis, 'Preview the current draft before applying it.');
  const actual = [input.name, input.content, input.destination];
  const expected = [draft.name, draft.content, draft.destination];
  requireThat(
    JSON.stringify(actual) === JSON.stringify(expected),
    'The draft changed. Preview its current content and destination before applying.'
  );
  validateDraft(draft.name, draft.content);
  return draft;
}

function messageText(value) {
  requireThat(
    typeof value === 'string' && value.trim() && value.length <= 16000,
    'Enter a message under 16000 characters.'
  );
  return value.trim();
}

export class ProjectAutomateMe {
  constructor(service, options = {}) {
    this.service = service;
    this.options = options;
    this.readOnly = options.readOnly === true;
    this.now = options.now || (() => new Date());
    this.directory = safeDirectory(service.root, ['.issues', 'factory-ui', 'project-automate-me'], !this.readOnly);
    this.sessions = new Map();
    this.active = new Map();
    this.providers = new Map();
    this.applying = new Set();
    this.restoreSessions();
  }

  restoreSessions() {
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory).filter((item) => /^[\w-]+\.json$/.test(item))) {
      const path = join(this.directory, name);
      requireThat(stat(path)?.isFile(), 'Reconcile the saved Automate me session file.');
      const session = JSON.parse(readFileSync(path, 'utf8'));
      requireThat(
        session.version === 1 && name === sessionId(session.id) + '.json',
        'Reconcile the saved Automate me session; it was not reset.'
      );
      this.sessions.set(session.id, session);
      this.reconcileSession(session);
    }
  }

  reconcileSession(session) {
    if (this.readOnly) return;
    if (!activeStatuses.has(session.status)) return;
    session.status = 'stopped';
    session.error =
      'The server stopped during this operation. The saved conversation is retained. Retry explicitly when its original chat is idle.';
    this.save(session);
  }

  get activeCount() {
    return this.active.size + this.applying.size;
  }

  view() {
    return {
      sessions: [...this.sessions.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((session) => this.publicSession(session)),
    };
  }

  publicSession(session) {
    const { historyMessages, existingModes, startup, skill, ...visible } = session;
    return structuredClone(visible);
  }

  save(session) {
    requireThat(!this.readOnly, 'Project preview cannot change Automate me sessions.');
    session.updatedAt = this.now().toISOString();
    writeJson(join(this.directory, sessionId(session.id) + '.json'), session);
    return { session: this.publicSession(session) };
  }

  selected(id) {
    const session = this.sessions.get(sessionId(id));
    requireThat(session, 'This Automate me session is unavailable.');
    return session;
  }

  base(destination) {
    if (destination === 'project') return { base: this.service.root, parts: ['.agents', 'skills'] };
    const configured = this.options.personalRoot;
    if (configured) return { base: realpathSync(configured), parts: ['skills'] };
    return { base: realpathSync(process.env.CODEX_HOME || join(homedir(), '.codex')), parts: ['skills'] };
  }

  target(name, destination, create = false) {
    requireThat(safeName.test(name), 'Choose a lowercase skill name ending in -mode.');
    const { base, parts } = this.base(destination);
    const existing = existingModePaths(base, parts).find((item) => item.name === name);
    return join(safeDirectory(base, existing?.parts || [...parts, name], create), 'SKILL.md');
  }

  modes(destination, handle) {
    const { base, parts } = this.base(destination);
    return existingModePaths(base, parts)
      .filter((item) => !handle || item.name === `${handle.toLowerCase().replace(/[^a-z0-9-]/g, '')}-mode`)
      .slice(0, 20)
      .map((item) => ({ name: item.name, path: item.path, content: skillContent(item.path), destination }));
  }

  async action(input) {
    requireThat(!this.readOnly, 'Project preview cannot run Automate me operations.');
    this.service.ownServer();
    requireThat(input && typeof input.action === 'string', 'Choose an Automate me action.');
    if (input.action === 'automate-start') return this.start(input);
    const session = this.selected(input.id);
    if (input.action === 'automate-stop') return this.stop(session);
    const actions = {
      'automate-message': () => this.message(session, input),
      'automate-retry': () => this.whenIdle(session, () => this.retry(session)),
      'automate-preview': () => this.whenIdle(session, () => this.preview(session, input)),
      'automate-apply': () => this.whenIdle(session, () => this.apply(session, input)),
    };
    requireThat(Object.hasOwn(actions, input.action), 'Choose an Automate me action.');
    return actions[input.action]();
  }

  whenIdle(session, operation) {
    requireThat(!this.active.has(session.id), 'Wait for the current Automate me response or stop it first.');
    return operation();
  }

  start(input) {
    const id = sessionId(input.requestId || randomUUID());
    const window = windowRequest(input, this.now());
    const destination = requestedDestination(input.destination);
    const handle = typeof input.handle === 'string' ? input.handle.trim().slice(0, 80) : '';
    const requestBasis = digest(JSON.stringify([window.durationValue, window.durationUnit, destination, handle]));
    const previous = this.sessions.get(id);
    if (previous) {
      requireThat(
        previous.requestBasis === requestBasis,
        'This request already started with different settings. Reopen its saved session.'
      );
      return { session: this.publicSession(previous) };
    }
    const session = {
      version: 1,
      id,
      requestBasis,
      status: 'running',
      createdAt: this.now().toISOString(),
      durationValue: window.durationValue,
      durationUnit: window.durationUnit,
      destination,
      handle,
      window,
      messages: [],
      existingModes: this.modes(destination, handle),
    };
    this.sessions.set(id, session);
    session.messages.push({
      role: 'user',
      text: `Learn my working conventions from this project's last ${window.durationValue} ${window.durationUnit}, then help me draft or update my mode skill.`,
      at: this.now().toISOString(),
    });
    this.launch(session, true);
    return { session: this.publicSession(session) };
  }

  message(session, input) {
    const text = messageText(input.message);
    requireThat(session.status !== 'applied', 'Start a new Automate me session to revise an applied skill.');
    const requestId = sessionId(input.requestId || randomUUID());
    const previous = session.messages.find((message) => message.id === requestId);
    if (previous) {
      requireThat(previous.text === text, 'This message ID already contains different text.');
      return { session: this.publicSession(session) };
    }
    requireThat(!this.active.has(session.id), 'Wait for the current Automate me response or stop it first.');
    session.messages.push({ id: requestId, role: 'user', text, at: this.now().toISOString() });
    this.launch(session, !session.historyMessages);
    return { session: this.publicSession(session) };
  }

  retry(session) {
    requireThat(['failed', 'stopped'].includes(session.status), 'Retry a failed or stopped Automate me session.');
    requireThat(
      !session.startup || session.threadId || session.startup.status === 'ready',
      'The original chat creation is uncertain. Reconcile its identity before retrying.'
    );
    this.launch(session, !session.historyMessages);
    return { session: this.publicSession(session) };
  }

  launch(session, gather) {
    const controller = new AbortController();
    session.status = 'running';
    delete session.error;
    this.save(session);
    const active = { controller };
    this.active.set(session.id, active);
    active.task = this.run(session, gather, controller.signal).finally(() => {
      if (this.active.get(session.id) === active) this.active.delete(session.id);
    });
  }

  provider(session) {
    if (!this.providers.has(session.id)) {
      const provider = this.options.providerFactory
        ? this.options.providerFactory(session)
        : new AutomateProvider(this.service);
      this.providers.set(session.id, provider);
    }
    return this.providers.get(session.id);
  }

  async prepareHistory(session, signal) {
    const history = await (this.options.history || collectAutomateHistory)(this.service, session.window, signal);
    signal.throwIfAborted();
    session.history = history.coverage;
    session.historyMessages = history.messages;
    this.save(session);
  }

  conversationContext(session) {
    return {
      task: 'Run automate-me as a guided interview.',
      handle: session.handle,
      duration: session.window,
      history: { coverage: session.history, messages: session.historyMessages },
      existingModes: session.existingModes,
      conversation: session.messages,
      draft: session.draft ? { name: session.draft.name, content: session.draft.content } : null,
    };
  }

  receiveResponse(session, value) {
    const result = parseResponse(value);
    session.messages.push({ role: 'assistant', text: result.message, at: this.now().toISOString() });
    session.status = result.draft ? 'ready' : 'awaiting-input';
    if (result.draft) this.preview(session, { ...result.draft, destination: session.destination });
    else this.save(session);
  }

  failedResponse(session, signal, error) {
    session.status = signal.aborted ? 'stopped' : 'failed';
    session.error = redactValue(
      signal.aborted ? 'Automate me stopped. Its conversation and any reviewed draft were retained.' : error.message
    );
    this.save(session);
  }

  async run(session, gather, signal) {
    try {
      if (gather) await this.prepareHistory(session, signal);
      const result = await this.provider(session).turn(session, {
        signal,
        retain: (values) => {
          Object.assign(session, values);
          this.save(session);
        },
        context: this.conversationContext(session),
      });
      signal.throwIfAborted();
      this.receiveResponse(session, result);
    } catch (error) {
      this.failedResponse(session, signal, error);
    }
  }

  async stop(session) {
    const active = this.active.get(session.id);
    if (!active) return { session: this.publicSession(session) };
    session.status = 'stopping';
    this.save(session);
    active.controller.abort(Error('Stopped by user.'));
    try {
      await this.providers.get(session.id)?.stop(session);
    } catch {
      /* The saved original chat remains available for reconciliation. */
    }
    return { session: this.publicSession(session) };
  }

  preview(session, input) {
    requireThat(session.status !== 'applied', 'This skill was already applied. Start a new session for changes.');
    validateDraft(input.name, input.content);
    const destination = requestedDestination(input.destination ?? session.destination);
    const path = this.target(input.name, destination);
    const currentContent = skillContent(path);
    const reviewed = { name: input.name, content: input.content, destination, path, currentContent };
    session.draft = { ...reviewed, basis: digest(JSON.stringify(reviewed)) };
    return this.save(session);
  }

  replayApplied(session, input) {
    requireReviewedInput(session, input);
    requireThat(session.applied.basis === input.basis, 'This session already applied a different reviewed draft.');
    if (input.activate && !session.applied.activated) this.activate(session);
    return { session: this.publicSession(session) };
  }

  writeReviewedSkill(session, draft) {
    const path = this.target(draft.name, draft.destination, true);
    requireThat(path === draft.path, 'The skill location changed. Review it again.');
    const lock = join(dirname(path), '.timey-apply.lock');
    mkdirSync(lock);
    try {
      saveSkillDraft(path, draft);
    } finally {
      rmdirSync(lock);
    }
    session.applied = { path, basis: draft.basis, at: this.now().toISOString(), activated: false };
    session.status = 'applied';
    this.save(session);
  }

  apply(session, input) {
    requireThat(!this.readOnly, 'Project preview cannot apply skill changes.');
    requireThat(!this.applying.has(session.id), 'This skill is already being applied.');
    if (session.status === 'applied') return this.replayApplied(session, input);
    const draft = requireReviewedInput(session, input);
    this.applying.add(session.id);
    try {
      this.writeReviewedSkill(session, draft);
      if (input.activate) this.activate(session);
      return { session: this.publicSession(session) };
    } finally {
      this.applying.delete(session.id);
    }
  }

  activate(session) {
    requireThat(
      skillContent(session.applied.path) === session.draft.content,
      'The saved skill changed. Review it before activation.'
    );
    initializeFolderSettings(this.service.root);
    const settings = readFolderSettings(this.service.root, this.service.root);
    updateFolderSettings(this.service.root, {
      directory: this.service.root,
      revision: settings.revision,
      changes: { skill: session.draft.name },
    });
    session.applied.activated = true;
    session.applied.activationScope = 'Project default for future work';
    this.save(session);
  }

  close() {
    if (this.readOnly) return;
    for (const [id, active] of this.active) {
      active.controller.abort(Error('Server stopped.'));
      const session = this.sessions.get(id);
      session.status = 'stopped';
      session.error = 'The server stopped. Retry explicitly to continue the saved conversation.';
      this.save(session);
    }
    for (const provider of this.providers.values()) provider.close();
  }
}
