import { approvalReply } from './approval-options.mjs';
import { turnFailure } from './turn-failure.mjs';
import { redactValue } from './activity.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cleanEnvironment, requireThat } from './common.mjs';

// One local RPC connection. It never starts a thread or turn on construction.
export class CodexConnection {
  constructor({ command = 'codex', args = ['app-server', '--listen', 'stdio://'], onEvent = () => {} } = {}) {
    this.command = command;
    this.args = args;
    this.onEvent = onEvent;
    this.pending = new Map();
    this.requests = new Map();
    this.turns = new Map();
    this.approvalReviewers = new Map();
    this.serial = 0;
    this.phases = [];
  }
  phase(phase, method, threadId = null) {
    const entry = { phase, method, threadId, at: new Date().toISOString() };
    this.phases.push(entry);
    this.phases = this.phases.slice(-80);
    this.onEvent({ method: 'ui/transportPhase', params: entry });
  }
  async ready() {
    if (!this.starting) this.starting = this.connect();
    return this.starting;
  }
  async connect() {
    this.phase('connecting', 'initialize');
    this.child = spawn(this.command, this.args, { env: cleanEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', () =>
      this.fail(Error('Codex disconnected. Reconcile the saved conversation before resuming.'))
    );
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    this.child.stderr.on('data', () => {}); // Do not forward local configuration or credential diagnostics to the browser.
    const initialized = await this.call('initialize', {
      clientInfo: { name: 'timey_factory_ui', title: 'Timey factory', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: 'initialized' });
    this.phase('connected', 'initialize');
    return initialized;
  }
  send(value) {
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  call(method, params, onSlow = null, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      this.phase('requested', method, params.threadId);
      const timer = setTimeout(() => {
        this.phase('waiting', method, params.threadId);
        if (onSlow) {
          onSlow();
          return; // Creation is uncertain: retain the exact request until its reply or disconnect.
        }
        this.pending.delete(id);
        reject(Error(`${method} did not respond. Do not retry a creation without reconciliation.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, threadId: params.threadId });
      this.send({ id, method, params });
    });
  }
  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return this.fail(Error('Codex returned invalid protocol data.'));
    }
    if (message.id === undefined) return this.event(message);
    if (message.method) return this.request(message);
    this.reply(message);
  }
  reply(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.phase(message.error ? 'rejected' : 'replied', pending.method, pending.threadId);
    this.pending.delete(message.id);
    if (message.error) pending.reject(Error(message.error.message));
    else pending.resolve(message.result);
  }
  request(message) {
    const methods = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
    ];
    if (!methods.includes(message.method)) {
      this.send({
        id: message.id,
        error: { code: -32601, message: 'This client cannot handle that request. No permission was granted.' },
      });
      this.onEvent({
        method: 'ui/unsupportedRequest',
        params: { threadId: message.params?.threadId, request: message.method },
      });
      return;
    }
    this.requests.set(String(message.id), message);
    this.onEvent({
      method: 'ui/approval',
      params: { requestId: String(message.id), method: message.method, ...message.params },
    });
  }
  answer(id, threadId, response) {
    const request = this.requests.get(String(id));
    requireThat(request && request.params.threadId === threadId, 'This permission request is no longer pending.');
    const result = approvalResult(request, response);
    this.send({ id: request.id, result });
    this.requests.delete(String(id));
  }
  event(message) {
    const params = message.params || {};
    if (message.method === 'serverRequest/resolved') this.requests.delete(String(params.requestId));
    this.onEvent(message);
    const turn = this.turns.get(params.threadId);
    if (turn) this.turnEvent(message, turn);
  }
  turnEvent(message, turn) {
    const params = message.params;
    if (message.method === 'item/completed') this.captureMessage(params.item, turn);
    if (message.method !== 'turn/completed') return;
    this.phase('finished', 'turn/completed', params.threadId);
    this.turns.delete(params.threadId);
    this.clearRequests(params.threadId);
    if (params.turn.status === 'completed') turn.resolve(turn.text);
    else turn.reject(Error(redactValue(turnFailure(params.turn))));
  }
  captureMessage(item, turn) {
    if (item?.type === 'agentMessage') turn.text = item.text;
  }
  clearRequests(threadId) {
    for (const [id, request] of this.requests) if (request.params.threadId === threadId) this.requests.delete(id);
  }
  async start(cwd, sandbox = 'workspace-write', onStartup = () => {}) {
    await this.ready();
    onStartup({ status: 'starting' });
    const result = await this.call(
      'thread/start',
      {
        cwd,
        sandbox,
        approvalPolicy: 'on-request',
        approvalsReviewer: sandbox === 'workspace-write' ? 'auto_review' : 'user',
        ...permissionToolConfig(sandbox),
        serviceName: 'timey-factory-ui',
        ...factoryModel(cwd),
      },
      () =>
        onStartup({
          status: 'waiting',
          summary:
            'Codex is taking longer to open this chat. Waiting for the original request; no duplicate chat will be created.',
        })
    );
    onStartup({ status: 'ready', threadId: result.thread.id });
    this.approvalReviewers.set(result.thread.id, sandbox === 'workspace-write' ? 'auto_review' : 'user');
    return result.thread.id;
  }
  async resume(threadId, cwd, sandbox = 'workspace-write') {
    await this.ready();
    await this.call('thread/resume', {
      threadId,
      cwd,
      sandbox,
      approvalPolicy: 'on-request',
      approvalsReviewer: sandbox === 'workspace-write' ? 'auto_review' : 'user',
      ...permissionToolConfig(sandbox),
      excludeTurns: true,
    });
    this.approvalReviewers.set(threadId, sandbox === 'workspace-write' ? 'auto_review' : 'user');
  }
  async unarchive(threadId) {
    await this.ready();
    await this.call('thread/unarchive', { threadId });
  }
  async turn(threadId, cwd, prompt, outputSchema, extraInput = []) {
    requireThat(!this.turns.has(threadId), 'This conversation already has running work.');
    let resolve, reject;
    const completion = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    completion.catch(() => {}); // The RPC may fail before its completion is awaited.
    // Observe before the RPC reply, including very short turns.
    const turn = { resolve, reject, text: '', id: null };
    this.turns.set(threadId, turn);
    try {
      turn.started = this.call('turn/start', {
        threadId,
        cwd,
        approvalsReviewer: this.approvalReviewers.get(threadId),
        input: [{ type: 'text', text: prompt }, ...extraInput],
        outputSchema,
      });
      const started = await turn.started;
      if (this.turns.get(threadId) === turn) turn.id = started.turn.id;
    } catch (error) {
      this.turns.delete(threadId);
      reject(error);
    }
    return completion;
  }
  fail(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    for (const entry of this.turns.values()) entry.reject(error);
    this.pending.clear();
    this.turns.clear();
    this.requests.clear();
    this.starting = null;
  }
  close() {
    this.child?.kill('SIGTERM');
  }
}

function questionAnswer(question, response) {
  const text = response.answers?.[question.id];
  requireThat(typeof text === 'string' && text.trim(), 'Answer each question.');
  return [question.id, { answers: [text] }];
}
function approvalResult(request, response) {
  if (request.method === 'item/tool/requestUserInput')
    return { answers: Object.fromEntries(request.params.questions.map((q) => questionAnswer(q, response))) };
  return approvalReply(request, response.decision);
}

function permissionToolConfig(sandbox) {
  return sandbox === 'workspace-write' ? { config: { 'features.request_permissions_tool': true } } : {};
}

// Project preference applies only to new chats. Resumed work keeps its model.
function factoryModel(root) {
  const path = join(root, 'factory.config.json');
  if (!existsSync(path)) return {};
  const { factoryModel: model } = JSON.parse(readFileSync(path, 'utf8'));
  if (model === undefined) return {};
  requireThat(typeof model === 'string' && /^[a-zA-Z0-9._-]+$/.test(model), 'Choose a valid factory model ID.');
  return { model };
}
