import { readSkillExtension, personalSkillExtension, ensureSkillExtension } from './skill-list.mjs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, writeJson } from './common.mjs';
import { readModelSettings } from './model-settings.mjs';
import { createProjectDiscussProvider } from './project-discuss-provider.mjs';
import { LocalNotes } from './local-notes.mjs';
import { agentRecovery, recoverAgentSession } from './agent-recovery.mjs';
import { retainReportConversation } from './report-conversation.mjs';
import { isCodexWriterConflict } from './codex-thread-writer.mjs';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const stamp = () => new Date().toISOString();
const copy = (value) => structuredClone(value);
export async function projectDiscussionSkills(discussions, model = discussions.choices().defaults.model) {
  if (discussions.options.skills) return discussions.options.skills();
  return discussions.provider('_discovery').skills(model);
}
export function readClarificationSkills(root) {
  const paths = [
    fileURLToPath(new URL('../../factory/system/chat/grilling.md', import.meta.url)),
    personalSkillExtension('chat/grilling.md'),
    join(root, 'user/chat/grilling.md'),
  ];
  const entries = new Map(paths.flatMap(readSkillExtension).map((entry) => [entry.name, entry]));
  return [...entries.values()]
    .map(({ name, source }) => ({
      kind: 'skill',
      name,
      label: name
        .split('-')
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(' '),
      skill: name,
      ...(source ? { source } : {}),
    }))
    .concat({ kind: 'value', name: 'none', label: 'No Grilling' });
}

function checkedId(id) {
  requireThat(typeof id === 'string' && idPattern.test(id), 'Choose a valid project conversation or message.');
  return id;
}
function text(value, empty = false) {
  requireThat(
    typeof value === 'string' && value.length <= 100000 && (empty || value.trim()),
    'Enter a message of up to 100,000 characters.'
  );
  return value;
}
function containsMessage(session, id) {
  return [...session.messages, ...session.queue].some((message) => message.id === id);
}
function discussionOwnerMatches(session, ownership) {
  return JSON.stringify(session.ownership) === JSON.stringify(ownership);
}
function reportMessageContext(input) {
  return input.reportContext ? { reportContext: copy(input.reportContext) } : {};
}
function publicEvent(event) {
  if (event.method === 'item/agentMessage/delta' || event.method === 'ui/transportPhase') return null;
  return event;
}

export class ProjectDiscuss {
  constructor(service, options = {}) {
    this.service = service;
    this.options = options;
    this.directory = join(service.root, '.issues/factory-ui/project-discuss');
    this.active = new Map();
    this.providers = new Map();
    this.closed = false;
  }
  file(id) {
    return join(this.directory, checkedId(id), 'conversation.json');
  }
  read(id) {
    const path = this.file(id);
    requireThat(existsSync(path), 'This project conversation no longer exists.');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  save(session) {
    mkdirSync(join(this.directory, checkedId(session.id)), { recursive: true });
    session.updatedAt = stamp();
    writeJson(this.file(session.id), session);
    return session;
  }
  change(id, update) {
    const session = this.read(id);
    update(session);
    return this.save(session);
  }
  records() {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && idPattern.test(entry.name) && existsSync(this.file(entry.name)))
      .map((entry) => this.read(entry.name))
      .filter((session) => !session.closedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  choices() {
    return (this.options.modelSettings || readModelSettings)(this.service.root, { initialize: false });
  }
  settings(input = {}, previous = {}) {
    const choices = this.choices();
    const result = { ...choices.defaults, clarificationSkill: 'none', skills: [], ...previous, ...input };
    requireThat(
      choices.models.some(({ id }) => id === result.model),
      'Choose an available model.'
    );
    requireThat(choices.efforts.includes(result.effort), 'Choose an available effort level.');
    requireThat(
      readClarificationSkills(this.service.root).some(({ name }) => name === result.clarificationSkill),
      'Choose a listed clarification skill.'
    );
    requireThat(
      Array.isArray(result.skills) &&
        result.skills.length <= 8 &&
        result.skills.every((s) => typeof s === 'string') &&
        new Set(result.skills).size === result.skills.length,
      'Choose up to eight distinct skills.'
    );
    return result;
  }
  attachment(sessionId, id) {
    const path = join(this.directory, checkedId(sessionId), 'attachments', checkedId(id) + '.json');
    requireThat(existsSync(path), 'This attachment is no longer available.');
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    return { ...metadata, path: join(this.directory, sessionId, 'attachments', id + '.bin') };
  }
  attachments(sessionId, files = []) {
    requireThat(Array.isArray(files) && files.length <= 8, 'Attach up to eight files.');
    let total = 0;
    return files.map((file) => {
      if (file.id) {
        const saved = this.attachment(sessionId, file.id);
        total += saved.size;
        requireThat(total <= 8 * 1024 * 1024, 'Attachments must total at most 8 MB.');
        return saved;
      }
      requireThat(
        typeof file.name === 'string' &&
          file.name.length > 0 &&
          file.name.length <= 255 &&
          typeof file.data === 'string' &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(file.data),
        'Choose a valid attachment.'
      );
      const bytes = Buffer.from(file.data, 'base64');
      total += bytes.length;
      requireThat(total <= 8 * 1024 * 1024, 'Attachments must total at most 8 MB.');
      const id = randomUUID();
      const folder = join(this.directory, checkedId(sessionId), 'attachments');
      mkdirSync(folder, { recursive: true });
      const metadata = {
        id,
        name: file.name,
        mime: typeof file.mime === 'string' ? file.mime.slice(0, 120) : 'application/octet-stream',
        size: bytes.length,
      };
      writeFileSync(join(folder, id + '.bin'), bytes, { mode: 0o600, flag: 'wx' });
      writeJson(join(folder, id + '.json'), metadata);
      return { ...metadata, path: join(folder, id + '.bin') };
    });
  }
  publicAttachment(sessionId, file) {
    const { path, ...metadata } = file;
    return {
      ...metadata,
      url:
        '/api/project-discuss-attachment?conversation=' +
        encodeURIComponent(sessionId) +
        '&attachment=' +
        encodeURIComponent(file.id),
    };
  }
  publicSession(session) {
    const result = copy(session);
    delete result.threadId;
    delete result.startup;
    delete result.turnId;
    delete result.toolReceipts;
    const expose = (message) => {
      if (message.role === 'assistant') message.text = message.text.replace(/\n?```timey-suggestion[\s\S]*$/, '');
      if (isCodexWriterConflict(message.error))
        message.error =
          'Another Codex session held the conversation lock. Retry to check whether it has been released.';
      message.attachments = (message.attachments || []).map((file) => this.publicAttachment(session.id, file));
      delete message.stream;
      return message;
    };
    result.messages = result.messages.map(expose);
    result.queue = result.queue.map(expose);
    result.draft.attachments = (result.draft.attachments || []).map((file) => this.publicAttachment(session.id, file));
    if (result.activeMessageId && !this.active.has(result.id)) {
      result.status = 'interrupted';
      result.paused = true;
      result.recovery = 'The server stopped during a response. Retry explicitly to reconcile the saved conversation.';
      delete result.threadLock;
    }
    return result;
  }
  readOwned(id, ownership) {
    const session = this.read(id);
    requireThat(discussionOwnerMatches(session, ownership), 'Choose a conversation belonging to this workspace.');
    return session;
  }
  view(id, ownership) {
    const sessions = this.records().filter(
      (session) => discussionOwnerMatches(session, ownership) && !session.noteContext
    );
    const requested = id ? this.readOwned(id, ownership) : null;
    const selected = requested && !requested.closedAt ? requested : sessions[0];
    return {
      conversations: sessions.map(({ id, title, status, updatedAt }) => ({ id, title, status, updatedAt })),
      selected: selected ? this.publicSession(selected) : null,
      ...this.choices(),
      clarificationSkills: readClarificationSkills(this.service.root),
    };
  }
  provider(id) {
    if (!this.providers.has(id))
      this.providers.set(
        id,
        this.options.createProvider
          ? this.options.createProvider(this.service)
          : createProjectDiscussProvider(this.service, this.options)
      );
    return this.providers.get(id);
  }
  envelope(session, input) {
    return {
      id: checkedId(input.clientId || randomUUID()),
      role: 'user',
      text: text(input.text ?? '', Boolean(input.attachments?.length)),
      settings: this.settings(input.settings, session.settings),
      attachments: this.attachments(session.id, input.attachments || []),
      status: 'queued',
      ...reportMessageContext(input),
      createdAt: stamp(),
    };
  }
  async prepareNote(note) {
    const value = await this.action({ action: 'create', requestId: 'local-note-' + note.id });
    const id = value.selected.id;
    this.change(id, (session) => {
      if (!session.noteContext || session.noteContext.text !== note.text) {
        const initial = !session.noteContext;
        session.noteContext = { ...session.noteContext, id: note.id, text: note.text };
        session.title = 'Note: ' + note.text.split('\n')[0].slice(0, 72);
        session.messages.push({
          ...this.envelope(session, {
            text:
              'We are discussing this local note:\n\n' +
              note.text +
              '\n\nContext prepared. Wait for my first prompt before answering.',
          }),
          status: 'context',
        });
        if (initial) session.draft.text = 'Help me think through this note and identify a useful next step.';
      }
      if (note.issueId && !session.messages.some((message) => message.id === 'issue-' + note.issueId)) {
        session.messages.push({
          id: 'issue-' + note.issueId,
          role: 'assistant',
          status: 'completed',
          createdAt: stamp(),
          text:
            'Created [the new issue](/?issue=' +
            encodeURIComponent(note.issueId) +
            '). We can continue discussing it here. Would you like to delete the original note?',
          localNoteId: note.id,
        });
        session.noteContext.issueId = note.issueId;
      }
    });
    return this.view(id);
  }
  createSession(requestId, input, context) {
    const ownership = context.ownership;
    return {
      id: randomUUID(),
      requestId,
      ...(ownership ? { ownership } : {}),
      title: ownership ? 'Investigation discussion' : 'New conversation',
      createdAt: stamp(),
      updatedAt: stamp(),
      status: 'idle',
      settings: this.settings(input.settings),
      draft: { text: '', attachments: [] },
      messages: context.messages || [],
      queue: [],
      approvals: [],
      paused: false,
      activeMessageId: null,
    };
  }
  create(input, context) {
    const ownership = context.ownership;
    const resultView = (id) => this.view(id, ownership);
    const requestId = checkedId(input.requestId || randomUUID());
    const existing = this.records().find(
      (session) => session.requestId === requestId && discussionOwnerMatches(session, ownership)
    );
    if (existing) return resultView(existing.id);
    const session = this.createSession(requestId, input, context);
    this.save(session);
    return resultView(session.id);
  }
  async action(input, context = {}) {
    const ownership = context.ownership;
    const resultView = (id) => this.view(id, ownership);
    requireThat(!this.closed && this.service.reviewMode !== 'preview', 'Open the live project to use Discuss.');
    this.service.ownServer();
    const operation = input.action;
    if (['send', 'retry', 'resume', 'steer'].includes(operation))
      this.service.serverControl?.allow('/api/project-discuss-action', input);
    if (operation === 'open-skill-extension') {
      const path = ensureSkillExtension(join(this.service.root, 'user/chat/grilling.md'));
      if (this.options.openFile) await this.options.openFile(path);
      else await promisify(execFile)('/usr/bin/open', [path]);
      return resultView(input.conversationId || undefined);
    }
    if (operation === 'create') return this.create(input, context);
    const id = checkedId(input.conversationId);
    let session = this.readOwned(id, ownership);
    if (operation === 'delete-note') {
      requireThat(
        session.messages.some((message) => message.localNoteId === input.noteId),
        'Choose the original note offered in this conversation.'
      );
      const notes = new LocalNotes(this.service.root);
      const current = notes.view();
      if (current.notes.some((note) => note.id === input.noteId))
        notes.action({ action: 'delete', id: input.noteId, basis: current.basis });
      this.change(id, (saved) => {
        for (const message of saved.messages) if (message.localNoteId === input.noteId) message.localNoteDeleted = true;
      });
    } else if (operation === 'close') {
      requireThat(!session.closedAt, 'This project conversation is already closed.');
      this.change(id, (s) => {
        s.closedAt = stamp();
      });
      return resultView(input.returnTo ? checkedId(input.returnTo) : undefined);
    } else if (operation === 'settings')
      this.change(id, (s) => {
        s.settings = this.settings(input.settings, s.settings);
      });
    else if (operation === 'draft')
      this.change(id, (s) => {
        s.draft = {
          text: text(input.draft?.text ?? '', true),
          attachments: this.attachments(id, input.draft?.attachments ?? s.draft.attachments),
        };
      });
    else if (operation === 'send') {
      const clientId = checkedId(input.clientId || randomUUID());
      if (!containsMessage(session, clientId)) {
        const message = this.envelope(session, { ...input, clientId, reportContext: context.reportContext });
        this.change(id, (s) => {
          if (s.title === 'New conversation') s.title = message.text.slice(0, 80) || 'Attached files';
          const failed =
            !s.activeMessageId && s.messages.findLast((entry) => entry.role === 'assistant')?.status === 'failed';
          if (failed) {
            s.paused = false;
            s.queue.unshift(message);
          } else {
            s.queue.push(message);
          }
          s.draft = { text: '', attachments: [] };
        });
      }
      this.dispatch(id);
    } else if (operation === 'edit-queued') {
      const previous = session.queue.find((m) => m.id === input.messageId);
      requireThat(previous, 'That message has already started or was removed.');
      const next = this.envelope(session, {
        ...previous,
        ...input,
        clientId: previous.id,
        reportContext: previous.reportContext,
      });
      this.change(id, (s) => {
        s.queue[s.queue.findIndex((m) => m.id === previous.id)] = next;
      });
    } else if (operation === 'remove-queued') {
      requireThat(
        session.queue.some((m) => m.id === input.messageId),
        'That queued message is no longer available.'
      );
      this.change(id, (s) => {
        s.queue = s.queue.filter((m) => m.id !== input.messageId);
      });
    } else if (operation === 'retry') {
      requireThat(!this.active.has(id), 'Stop the active response before retrying.');
      if (agentRecovery(this.service.root, session.threadId))
        recoverAgentSession(this.service.root, session.threadId, input.confirmedAgentRecovery);
      const selected = session.messages.find((m) => m.id === input.messageId);
      const original =
        selected?.role === 'assistant' ? session.messages.find((m) => m.id === selected.replyTo) : selected;
      requireThat(original?.role === 'user', 'Choose the message to retry.');
      const clientId = checkedId(input.clientId || randomUUID());
      if (!containsMessage(session, clientId))
        this.change(id, (s) => {
          for (const m of s.messages) if (m.status === 'running') m.status = 'interrupted';
          s.queue.unshift({
            ...copy(original),
            id: clientId,
            retryOf: original.id,
            status: 'queued',
            createdAt: stamp(),
          });
          s.activeMessageId = null;
          s.paused = false;
        });
      this.dispatch(id);
    } else if (operation === 'stop') {
      this.change(id, (s) => {
        s.paused = true;
      });
      const active = this.active.get(id);
      if (active) {
        active.controller.abort();
        await this.provider(id).stop(session);
      }
    } else if (operation === 'resume') {
      requireThat(
        !session.activeMessageId || this.active.has(id),
        'Retry the interrupted message before resuming queued work.'
      );
      this.change(id, (s) => {
        s.paused = false;
      });
      this.dispatch(id);
    } else if (operation === 'steer') {
      requireThat(this.active.has(id), 'There is no active response to steer.');
      const message = session.queue.find((m) => m.id === input.messageId);
      requireThat(message, 'Choose a queued message to steer.');
      await this.provider(id).steer(session, message);
      this.change(id, (s) => {
        s.queue = s.queue.filter((m) => m.id !== message.id);
        s.messages.push({ ...message, status: 'steered' });
      });
    } else if (operation === 'answer') {
      requireThat(
        this.active.has(id) && session.approvals.some((a) => a.requestId === input.requestId),
        'This request is no longer pending.'
      );
      await this.provider(id).answer(session, input.requestId, input.response);
      this.change(id, (s) => {
        s.approvals = s.approvals.filter((a) => a.requestId !== input.requestId);
      });
    } else throw Error('Unknown project conversation operation.');
    return resultView(id);
  }
  dispatch(id) {
    const session = this.read(id);
    if (this.closed || this.active.has(id) || session.paused || !session.queue.length || session.activeMessageId)
      return;
    const controller = new AbortController();
    const active = { controller };
    this.active.set(id, active);
    active.task = this.run(id, controller).finally(() => {
      this.active.delete(id);
      if (!this.closed) this.dispatch(id);
    });
    active.task.catch(() => {});
  }
  async run(id, controller) {
    let message, responseId;
    this.change(id, (s) => {
      message = s.queue.shift();
      message.status = 'sent';
      s.messages.push(message);
      responseId = randomUUID();
      s.activeMessageId = message.id;
      s.status = 'running';
      s.messages.push({
        id: responseId,
        role: 'assistant',
        replyTo: message.id,
        ...(message.reportContext ? { reportContext: copy(message.reportContext) } : {}),
        text: '',
        status: 'running',
        settings: copy(message.settings),
        attachments: [],
        events: [],
        createdAt: stamp(),
      });
    });
    try {
      this.service.serverControl?.allow('/api/project-discuss-action', { action: 'send' });
      const result = await this.provider(id).turn(this.read(id), message, {
        signal: controller.signal,
        retain: (patch) => this.change(id, (s) => Object.assign(s, patch)),
        event: (event) =>
          this.change(id, (s) => {
            const response = s.messages.find((m) => m.id === responseId);
            if (event.method === 'item/agentMessage/delta') response.text += event.params.delta || '';
            const activity = publicEvent(event);
            if (activity) response.events = [...response.events, activity].slice(-300);
            if (event.method === 'ui/approval') {
              const approval = event.params;
              s.approvals = s.approvals.filter((a) => a.requestId !== approval.requestId);
              s.approvals.push(approval);
            }
            if (event.method === 'serverRequest/resolved')
              s.approvals = s.approvals.filter((a) => a.requestId !== String(event.params.requestId));
          }),
      });
      this.change(id, (s) => {
        const response = s.messages.find((m) => m.id === responseId);
        response.text = result.text;
        response.suggestion = result.suggestion || '';
        response.status = controller.signal.aborted ? 'stopped' : 'completed';
      });
    } catch (error) {
      this.change(id, (s) => {
        const response = s.messages.find((m) => m.id === responseId);
        response.status = controller.signal.aborted ? 'stopped' : 'failed';
        response.error = error.message;
        if (error.partialText && !response.text) response.text = error.partialText;
        s.paused = true;
      });
    } finally {
      this.change(id, (s) => {
        s.activeMessageId = null;
        s.approvals = [];
        s.status = s.paused ? 'paused' : 'idle';
      });
      retainReportConversation(this.service.root, this.read(id));
    }
  }
  close() {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort();
    for (const provider of this.providers.values()) provider.close();
  }
}
