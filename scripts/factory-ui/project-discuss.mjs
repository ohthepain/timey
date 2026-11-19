import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, writeJson } from './common.mjs';
import { readModelSettings } from './model-settings.mjs';
import { createProjectDiscussProvider } from './project-discuss-provider.mjs';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const stamp = () => new Date().toISOString();
const copy = (value) => structuredClone(value);
export const clarificationSkills = [
  { kind: 'skill', name: 'grilling', label: 'Grilling', skill: 'grilling' },
  { kind: 'skill', name: 'grill-me', label: 'Grill Me', skill: 'grill-me' },
  { kind: 'skill', name: 'grill-with-docs', label: 'Grill with Docs', skill: 'grill-with-docs' },
  { kind: 'value', name: 'none', label: 'No Grilling' },
];
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
      clarificationSkills.some(({ name }) => name === result.clarificationSkill),
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
    }
    return result;
  }
  view(id) {
    const sessions = this.records();
    const requested = id ? this.read(id) : null;
    const selected = requested && !requested.closedAt ? requested : sessions[0];
    return {
      conversations: sessions.map(({ id, title, status, updatedAt }) => ({ id, title, status, updatedAt })),
      selected: selected ? this.publicSession(selected) : null,
      ...this.choices(),
      clarificationSkills,
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
  async skills() {
    if (this.options.skills) return this.options.skills();
    const provider = this.provider('_discovery');
    return provider.skills();
  }
  envelope(session, input) {
    return {
      id: checkedId(input.clientId || randomUUID()),
      role: 'user',
      text: text(input.text ?? '', Boolean(input.attachments?.length)),
      settings: this.settings(input.settings, session.settings),
      attachments: this.attachments(session.id, input.attachments || []),
      status: 'queued',
      createdAt: stamp(),
    };
  }
  async action(input) {
    requireThat(!this.closed && this.service.reviewMode !== 'preview', 'Open the live project to use Discuss.');
    this.service.ownServer();
    const operation = input.action;
    if (['send', 'retry', 'resume', 'steer'].includes(operation))
      this.service.serverControl?.allow('/api/project-discuss-action', input);
    if (operation === 'create') {
      const requestId = checkedId(input.requestId || randomUUID());
      const existing = this.records().find((session) => session.requestId === requestId);
      if (existing) return this.view(existing.id);
      const session = {
        id: randomUUID(),
        requestId,
        title: 'New conversation',
        createdAt: stamp(),
        updatedAt: stamp(),
        status: 'idle',
        settings: this.settings(input.settings),
        draft: { text: '', attachments: [] },
        messages: [],
        queue: [],
        approvals: [],
        paused: false,
        activeMessageId: null,
      };
      this.save(session);
      return this.view(session.id);
    }
    const id = checkedId(input.conversationId);
    let session = this.read(id);
    if (operation === 'close') {
      requireThat(!session.closedAt, 'This project conversation is already closed.');
      this.change(id, (s) => {
        s.closedAt = stamp();
      });
      return this.view(input.returnTo ? checkedId(input.returnTo) : undefined);
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
      if (!session.messages.some((m) => m.id === clientId) && !session.queue.some((m) => m.id === clientId)) {
        const message = this.envelope(session, { ...input, clientId });
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
      const next = this.envelope(session, { ...previous, ...input, clientId: previous.id });
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
      const selected = session.messages.find((m) => m.id === input.messageId);
      const original =
        selected?.role === 'assistant' ? session.messages.find((m) => m.id === selected.replyTo) : selected;
      requireThat(original?.role === 'user', 'Choose the message to retry.');
      const clientId = checkedId(input.clientId || randomUUID());
      if (!session.messages.some((m) => m.id === clientId) && !session.queue.some((m) => m.id === clientId))
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
    return this.view(id);
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
    }
  }
  close() {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort();
    for (const provider of this.providers.values()) provider.close();
  }
}
