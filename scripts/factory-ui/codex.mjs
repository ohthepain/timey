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
    this.serial = 0;
  }
  async ready() {
    if (!this.starting) this.starting = this.connect();
    return this.starting;
  }
  async connect() {
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
    return initialized;
  }
  send(value) {
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`${method} did not respond. Do not retry a creation without reconciliation.`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
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
    this.turns.delete(params.threadId);
    this.clearRequests(params.threadId);
    if (params.turn.status === 'completed') turn.resolve(turn.text);
    else turn.reject(Error('Codex turn ' + params.turn.status + '. Review its progress before continuing.'));
  }
  captureMessage(item, turn) {
    if (item?.type === 'agentMessage') turn.text = item.text;
  }
  clearRequests(threadId) {
    for (const [id, request] of this.requests) if (request.params.threadId === threadId) this.requests.delete(id);
  }
  async start(cwd, sandbox = 'workspace-write') {
    await this.ready();
    const result = await this.call('thread/start', {
      cwd,
      sandbox,
      approvalPolicy: 'on-request',
      serviceName: 'timey-factory-ui',
    });
    return result.thread.id;
  }
  async resume(threadId, cwd, sandbox = 'workspace-write') {
    await this.ready();
    await this.call('thread/resume', { threadId, cwd, sandbox, approvalPolicy: 'on-request' });
  }
  async turn(threadId, cwd, prompt, outputSchema) {
    requireThat(!this.turns.has(threadId), 'This conversation already has running work.');
    let resolve, reject;
    const completion = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    completion.catch(() => {}); // The RPC may fail before its completion is awaited.
    // Observe before the RPC reply, including very short turns.
    this.turns.set(threadId, { resolve, reject, text: '' });
    try {
      await this.call('turn/start', { threadId, cwd, input: [{ type: 'text', text: prompt }], outputSchema });
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
  requireThat(['allow', 'decline'].includes(response.decision), 'Choose allow or decline.');
  if (request.method === 'item/permissions/requestApproval') return permissionResult(request, response);
  return { decision: response.decision === 'allow' ? 'accept' : 'decline' };
}

function permissionResult(request, response) {
  return { permissions: response.decision === 'allow' ? request.params.permissions : {}, scope: 'turn' };
}
