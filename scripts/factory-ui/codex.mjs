import { meterCodexTurn } from './codex-diagnostics.mjs';
import { createChatToolMcp } from './chat-tool-mcp.mjs';
import { approvalReply } from './approval-options.mjs';
import { turnFailure } from './turn-failure.mjs';
import { validateTextInput } from './codex-input.mjs';
import { redactValue } from './activity.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cleanEnvironment, requireThat, digest } from './common.mjs';
import { newChatModelSettings } from './model-settings.mjs';
import { agentModel } from './agent-models.mjs';

// One local RPC connection. It never starts a thread or turn on construction.
export class CodexConnection {
  constructor({
    command = 'codex',
    args = ['app-server', '--listen', 'stdio://'],
    onEvent = () => {},
    experimentalApi = false,
    mcpTools,
    model,
  } = {}) {
    this.command = command;
    this.args = args;
    this.onEvent = onEvent;
    this.experimentalApi = experimentalApi;
    this.mcpTools = mcpTools;
    this.model = model;
    this.pending = new Map();
    this.requests = new Map();
    this.turns = new Map();
    this.threadDiagnostics = new Map();
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
    const toolArgs = await this.prepareChatTools();
    requireThat(!this.closing, 'This Codex connection closed before startup completed.');
    this.child = spawn(this.command, [...toolArgs, ...this.args], {
      env: cleanEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('error', (error) => this.disconnected(error));
    this.child.on('exit', () =>
      this.disconnected(Error('Codex disconnected. Reconcile the saved conversation before resuming.'))
    );
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    this.child.stderr.on('data', () => {}); // Do not forward local configuration or credential diagnostics to the browser.
    const initialized = await this.call('initialize', {
      clientInfo: { name: 'timey_factory_ui', title: 'Timey factory', version: '1.0.0' },
      capabilities: { experimentalApi: this.experimentalApi },
    });
    this.send({ method: 'initialized' });
    this.phase('connected', 'initialize');
    return initialized;
  }
  async prepareChatTools() {
    if (!this.mcpTools) return [];
    const adapter = await createChatToolMcp({ tools: this.mcpTools, active: () => this.turns.size > 0 });
    this.toolMcp = adapter;
    if (this.closing) await this.closeChatTools();
    return adapter.args;
  }
  closeChatTools() {
    const adapter = this.toolMcp;
    this.toolMcp = null;
    return adapter?.close();
  }
  disconnected(error) {
    void this.closeChatTools();
    this.fail(error);
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
      return this.fail(
        Object.assign(Error('Codex returned invalid protocol data.'), {
          recovery: {
            code: 'CODEX_PROTOCOL_INVALID',
            owner: 'coordinator',
            operation: 'reconcile-original-turn',
            bytes: Buffer.byteLength(line),
            sha256: digest(line),
          },
        })
      );
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
    turn.meter?.event(message);
    this.captureTurnProgress(message, turn);
    if (message.method !== 'turn/completed') return;
    turn.meter?.finish(params.turn.status);
    this.phase('finished', 'turn/completed', params.threadId);
    this.turns.delete(params.threadId);
    this.clearRequests(params.threadId);
    if (params.turn.status === 'completed') turn.resolve(turn.text);
    else turn.reject(terminalTurnError(params.turn, turn));
  }
  captureTurnProgress(message, turn) {
    const params = message.params;
    if (message.method === 'item/agentMessage/delta') {
      captureDelta(turn, params);
    }
    if (message.method === 'item/completed') this.captureMessage(params.item, turn);
  }

  captureMessage(item, turn) {
    if (item?.type === 'agentMessage') {
      turn.text = item.text;
      turn.fragments ||= new Map();
      turn.fragments.set(item.id, item.text);
    }
  }
  clearRequests(threadId) {
    for (const [id, request] of this.requests) if (request.params.threadId === threadId) this.requests.delete(id);
  }
  threadModelSettings(root, issueId) {
    const settings = newChatModelSettings(root, issueId);
    return { ...settings, model: this.model || settings.model };
  }
  async start(
    cwd,
    sandbox = 'workspace-write',
    onStartup = () => {},
    issueId = null,
    settingsRoot = cwd,
    instructions,
    dynamicTools
  ) {
    await this.ready();
    onStartup({ status: 'starting' });
    const settings = this.threadModelSettings(settingsRoot, issueId);
    requireThat(
      agentModel(settings.model).provider === 'codex',
      'This workflow requires a Codex model. Use a native-agent chat or ordinary Flow block for Claude and Gemini.'
    );
    const result = await this.call(
      'thread/start',
      {
        cwd,
        sandbox,
        approvalPolicy: 'on-request',
        approvalsReviewer: sandbox === 'workspace-write' ? 'auto_review' : 'user',
        ...permissionToolConfig(sandbox),
        serviceName: 'timey-factory-ui',
        ...(instructions === undefined ? {} : { developerInstructions: instructions }),
        dynamicTools,
        model: settings.model,
      },
      () =>
        onStartup({
          status: 'waiting',
          summary:
            'Codex is taking longer to open this chat. Waiting for the original request; no duplicate chat will be created.',
        })
    );
    this.threadDiagnostics.set(result.thread.id, { issueId, model: result.model ?? settings.model });
    onStartup({ status: 'ready', threadId: result.thread.id });
    this.approvalReviewers.set(result.thread.id, sandbox === 'workspace-write' ? 'auto_review' : 'user');
    return result.thread.id;
  }
  async resume(threadId, cwd, sandbox = 'workspace-write', instructions) {
    await this.ready();
    const result = await this.call('thread/resume', {
      threadId,
      cwd,
      sandbox,
      approvalPolicy: 'on-request',
      approvalsReviewer: sandbox === 'workspace-write' ? 'auto_review' : 'user',
      ...permissionToolConfig(sandbox),
      ...(instructions === undefined ? {} : { developerInstructions: instructions }),
      excludeTurns: true,
    });
    this.threadDiagnostics.set(threadId, { ...this.threadDiagnostics.get(threadId), model: result?.model });
    this.approvalReviewers.set(threadId, sandbox === 'workspace-write' ? 'auto_review' : 'user');
  }
  async unarchive(threadId) {
    await this.ready();
    await this.call('thread/unarchive', { threadId });
  }
  async turn(threadId, cwd, prompt, outputSchema, extraInput = [], settings = null, receipt = null) {
    requireThat(
      !settings || agentModel(settings.model).provider === 'codex',
      'This workflow requires a Codex model. Use a native-agent chat or ordinary Flow block for Claude and Gemini.'
    );
    validateTextInput(prompt);
    requireThat(!this.turns.has(threadId), 'This conversation already has running work.');
    let resolve, reject;
    const completion = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    completion.catch(() => {}); // The RPC may fail before its completion is awaited.
    // Observe before the RPC reply, including very short turns.
    const meter = meterCodexTurn({
      cwd,
      prompt,
      extraInput,
      threadId,
      thread: this.threadDiagnostics.get(threadId),
      settings,
    });
    const turn = { resolve, reject, text: '', id: null, meter };
    this.turns.set(threadId, turn);
    try {
      const request = () =>
        this.call('turn/start', {
          threadId,
          cwd,
          ...(receipt ? { clientUserMessageId: receipt.clientId } : {}),
          approvalsReviewer: this.approvalReviewers.get(threadId),
          input: [{ type: 'text', text: prompt }, ...extraInput],
          outputSchema,
          ...(settings ? { model: settings.model, effort: settings.effort } : {}),
        });
      let started;
      for (let attempt = 0; ; attempt++) {
        try {
          turn.started = request();
          started = await turn.started;
          break;
        } catch (error) {
          if (!/already has an active writer/i.test(error.message) || attempt >= 9) throw error;
          meter.retry();
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (this.turns.get(threadId) === turn) turn.id = started.turn.id;
      receipt?.accepted({ threadId, turnId: started.turn.id });
    } catch (error) {
      this.turns.delete(threadId);
      meter.finish('dispatch failed');
      reject(error);
    }
    return completion;
  }
  fail(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    for (const entry of this.turns.values()) {
      entry.meter?.finish('disconnected');
      entry.reject(error);
    }
    this.pending.clear();
    this.turns.clear();
    this.requests.clear();
    this.starting = null;
  }
  close() {
    this.closing = true;
    this.child?.kill('SIGTERM');
    void this.closeChatTools();
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

function terminalTurnError(result, turn) {
  return Object.assign(Error(redactValue(turnFailure(result))), {
    terminalStatus: result.status,
    partialText: redactValue(partialTurnText(turn).slice(0, 32000)),
  });
}
function partialTurnText(turn) {
  if (turn.fragments) return [...turn.fragments.values()].join('\n\n');
  return turn.text || '';
}

function captureDelta(turn, params) {
  turn.fragments ||= new Map();
  turn.fragments.set(params.itemId, (turn.fragments.get(params.itemId) || '') + params.delta);
}

export async function interruptCodexTurn(connection, threadId) {
  const turn = connection.turns.get(threadId);
  if (!turn) return { interrupted: false };
  const started = await turn.started;
  if (connection.turns.get(threadId) !== turn) return { interrupted: false };
  await connection.call('turn/interrupt', { threadId, turnId: started.turn.id });
  return { interrupted: true };
}
