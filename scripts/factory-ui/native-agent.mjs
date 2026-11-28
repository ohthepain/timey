import { assertProviderActive, guardProviderWork, observeProvider, providerCatalogs } from './provider-runtime.mjs';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { AgentProcess } from './agent-process.mjs';
import { agentModel, sessionProvider } from './agent-models.mjs';
import { cleanEnvironment, requireThat, writeJson } from './common.mjs';
import { createChatToolMcp } from './chat-tool-mcp.mjs';
import { approvalReply } from './approval-options.mjs';
import { redactValue } from './activity.mjs';
import { isChatCommentary, stripChatProgress } from './chat-progress.mjs';
import { newChatModelSettings } from './model-settings.mjs';
import { validateTextInput } from './codex-input.mjs';
import { agentSessionPath } from './agent-recovery.mjs';

const sessionKey = ({ threadId, cwd, sandbox, instructions }) => JSON.stringify([threadId, cwd, sandbox, instructions]);
const rejectedStartup = (error) =>
  error.turnRejected || ['AGENT_NOT_INSTALLED', 'AGENT_START_FAILED', 'AGENT_REJECTED'].includes(error.code);

function skillsInDirectory(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(directory, entry.name, 'SKILL.md'))
    .filter(existsSync)
    .filter((path) => statSync(path).isFile())
    .map((path) => ({ name: basename(dirname(path)), path, enabled: true }));
}
function localSkills(cwd) {
  const paths = [
    join(cwd, '.agents/skills'),
    join(cwd, '.claude/skills'),
    join(cwd, '.gemini/skills'),
    join(homedir(), '.codex/skills'),
    join(homedir(), '.agents/skills'),
    join(homedir(), '.claude/skills'),
    join(homedir(), '.gemini/skills'),
  ];
  return { data: [{ skills: paths.filter(existsSync).flatMap(skillsInDirectory) }] };
}

function googleMcpServers(mcp) {
  if (!mcp) return [];
  return [
    {
      type: 'http',
      name: 'timey_chat',
      url: mcp.url,
      headers: Object.entries(mcp.headers).map(([name, value]) => ({ name, value })),
    },
  ];
}
function terminalError(turn, error, uncertain) {
  return Object.assign(error, { partialText: turn.text, ...(uncertain ? {} : { terminalStatus: 'failed' }) });
}

function additionalInput(input) {
  return input
    .map((item) => {
      if (item.type === 'text') return item.text;
      if (item.type === 'skill') return `Selected skill ${item.name}:\n${readFileSync(item.path, 'utf8')}`;
      throw Error('This agent does not support the selected attachment type. No prompt was sent.');
    })
    .join('\n\n');
}

export class NativeAgentConnection {
  constructor(options) {
    this.options = options;
    this.attachmentKey = null;
    this.toolDefinitions = options.toolDefinitions || [];
    this.root = options.root;
    this.selection = agentModel(options.model);
    if (options.threadId) {
      const provider = sessionProvider(options.threadId);
      requireThat(provider !== 'codex', 'Choose the original agent for this conversation.');
      this.selection = { provider };
    }
    this.onEvent = options.onEvent || (() => {});
    this.turns = new Map();
    this.requests = new Map();
    this.approvalReviewers = new Map();
  }
  async ready() {
    requireThat(!this.closed, 'This agent connection is closed. Retry with a new connection.');
  }
  path(threadId) {
    return agentSessionPath(this.root, threadId);
  }
  retain(patch) {
    Object.assign(this.session, patch);
    writeJson(this.path(this.session.threadId), this.session);
  }
  async start(
    cwd,
    sandbox = 'workspace-write',
    onStartup = () => {},
    issueId = null,
    root = cwd,
    instructions = '',
    dynamicTools
  ) {
    this.root ||= root;
    const settings = this.initialSettings(root, issueId);
    this.selection = agentModel(settings.model);
    requireThat(this.selection.provider !== 'codex', 'Choose a native agent model.');
    assertProviderActive(this.root, this.selection.provider);
    const id = randomUUID();
    this.session = {
      threadId: `${this.selection.provider}:${id}`,
      nativeId: id,
      cwd,
      sandbox,
      model: settings.model,
      status: 'starting',
      instructions,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(join(this.root, '.issues/factory-ui/agent-sessions'), { recursive: true, mode: 0o700 });
    this.retain({});
    onStartup({ status: 'starting', threadId: this.session.threadId });
    try {
      await this.connect(false, dynamicTools);
    } catch (error) {
      if (rejectedStartup(error)) {
        this.retain({ status: 'rejected' });
        onStartup({ status: 'ready', threadId: null });
        error.turnRejected = true;
      }
      throw error;
    }
    this.retain({ status: 'idle' });
    onStartup({ status: 'ready', threadId: this.session.threadId });
    return this.session.threadId;
  }
  initialSettings(root, issueId) {
    return this.options.model ? { model: this.options.model } : newChatModelSettings(root, issueId);
  }
  stopProcess() {
    this.attachmentKey = null;
    this.process?.close();
  }
  async resume(threadId, cwd, sandbox = 'workspace-write', instructions) {
    requireThat(
      sessionProvider(threadId) === this.selection.provider,
      'Changing agents requires a fresh conversation and a handoff.'
    );
    requireThat(!this.turns.size, 'Stop the original agent turn before resuming this conversation.');
    const saved = JSON.parse(readFileSync(this.path(threadId), 'utf8'));
    requireThat(
      saved.status === 'idle',
      'The original agent operation is uncertain. Its retained session needs explicit recovery; no work was replayed.'
    );
    requireThat(saved.cwd === cwd, 'Resume this agent conversation in its original checkout.');
    const next = { ...saved, sandbox, instructions: instructions ?? saved.instructions };
    if (this.attachmentKey === sessionKey(next)) return;
    this.stopProcess();
    this.session = next;
    this.selection = agentModel(saved.model);
    await this.connect(true);
    this.retain({ status: 'idle' });
  }
  toolRegistry(definitions = this.toolDefinitions) {
    this.toolDefinitions = definitions;
    if (this.options.mcpTools) return this.options.mcpTools;
    if (this.blockTools) return this.blockTools;
    if (!definitions.length) return null;
    return { definitions, invoke: (tool, args) => this.invokeRegisteredTool(tool, args) };
  }
  async invokeRegisteredTool(tool, args) {
    const turn = this.turns.get(this.session.threadId);
    requireThat(turn, 'This tool has no active turn.');
    const result = await this.toolHandler({
      threadId: this.session.threadId,
      turnId: turn.id,
      callId: randomUUID(),
      tool,
      arguments: args,
    });
    requireThat(result.success, 'The Timey tool rejected this request.');
    return result.contentItems;
  }
  async tools(dynamicTools) {
    const tools = this.toolRegistry(dynamicTools);
    if (!tools) return null;
    await this.mcp?.close();
    this.mcp = await createChatToolMcp({ tools, active: () => this.turns.size > 0 });
    return this.mcp.config;
  }
  projectInstructions() {
    const roots = [...new Set([this.root, this.session.cwd])];
    const files = roots.map((root) => join(root, 'AGENTS.md')).filter(existsSync);
    return [
      this.session.instructions,
      ...files.map((path) => `Project instructions (${path}):\n${readFileSync(path, 'utf8')}`),
      'Read and follow applicable nested AGENTS.md files before editing their directories.',
      "Use this agent's native tools and permission interface. Codex-specific tool names and execution flags do not apply.",
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  async connect(resume, dynamicTools) {
    this.instructions = this.projectInstructions();
    const mcp = await this.tools(dynamicTools);
    try {
      assertProviderActive(this.root, this.selection.provider);
      requireThat(!this.closed, 'The agent connection closed before startup completed.');
      if (this.selection.provider === 'anthropic') await this.connectClaude(resume, mcp);
      else await this.connectGoogle(resume, mcp);
      this.attachmentKey = sessionKey(this.session);
    } catch (error) {
      if (!error.uncertain) error.turnRejected = true;
      this.stopProcess();
      await this.mcp?.close();
      throw error;
    }
  }
  launchAgent(command, args) {
    requireThat(!this.closed, 'The agent connection closed before startup completed.');
    const process = new AgentProcess({
      command: this.options.command || command,
      args: [...(this.options.commandArgs || []), ...args],
      cwd: this.session.cwd,
      env: { ...cleanEnvironment(), ...this.options.env, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' },
      protocol: command,
      event: (message) => this.nativeEvent(message),
      request: (message) => this.nativeRequest(message),
    });
    this.process = process;
    if (process.child.pid) this.retain({ ownerPid: process.child.pid });
    process.onFailure = (error) => {
      if (this.process !== process) return;
      this.attachmentKey = null;
      for (const turn of this.turns.values()) this.finish(turn, error, true);
    };
    return process;
  }
  async connectClaude(resume, mcp) {
    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      this.session.sandbox === 'read-only' ? 'plan' : 'default',
      '--model',
      this.selection.model,
      resume ? '--resume' : '--session-id',
      this.session.nativeId,
      '--append-system-prompt',
      this.instructions,
    ];
    if (mcp) args.push('--mcp-config', JSON.stringify({ mcpServers: { timey_chat: mcp } }));
    const initialized = await this.launchAgent('claude', args).call('initialize');
    requireThat(
      initialized.models?.some(({ value }) => value === this.selection.model),
      'The installed Claude Code does not advertise this model. Update Claude Code or choose another listed model.'
    );
  }
  async connectGoogle(resume, mcp) {
    const process = this.launchAgent('gemini', ['--acp', '--model', this.selection.model]);
    const initialized = await process.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'timey', version: '1' },
    });
    this.requireGoogleCapabilities(initialized, mcp);
    const response = await this.loadGoogleSession(resume, mcp);
    requireThat(
      response.models?.availableModels?.some(({ modelId }) => modelId === this.selection.model),
      'The installed Gemini agent does not advertise this model. Refresh available models; no substitute was selected.'
    );
    await process.call('session/set_model', { sessionId: this.session.nativeId, modelId: this.selection.model });
    await process.call('session/set_mode', {
      sessionId: this.session.nativeId,
      modeId: this.session.sandbox === 'read-only' ? 'plan' : 'default',
    });
  }
  requireGoogleCapabilities(initialized, mcp) {
    requireThat(initialized.agentCapabilities?.loadSession, 'Update Gemini CLI to a version with session loading.');
    if (mcp)
      requireThat(
        initialized.agentCapabilities.mcpCapabilities?.http,
        'Update Gemini CLI to a version with HTTP MCP support.'
      );
  }
  async loadGoogleSession(resume, mcp) {
    const mcpServers = googleMcpServers(mcp);
    const response = await this.process.call(resume ? 'session/load' : 'session/new', {
      cwd: this.session.cwd,
      ...(resume ? { sessionId: this.session.nativeId } : {}),
      mcpServers,
    });
    if (!resume) {
      requireThat(/^[a-f0-9-]{36}$/.test(response.sessionId), 'Gemini returned an invalid session identity.');
      this.retain({ nativeId: response.sessionId });
    }
    return response;
  }
  async call(method, params) {
    await this.ready();
    const handlers = {
      'skills/list': () => localSkills(params.cwds[0]),
      'thread/start': () => this.startThread(params),
      'thread/resume': () => this.resumeThread(params),
      'thread/read': () => this.readThread(params.threadId),
      'thread/name/set': () => ({}),
      'turn/interrupt': () => this.interrupt(params.threadId),
    };
    requireThat(
      Object.hasOwn(handlers, method),
      `This agent does not support ${method}. No substitute operation was performed.`
    );
    return handlers[method]();
  }
  async startThread(params) {
    const id = await this.start(
      params.cwd,
      params.sandbox,
      () => {},
      null,
      this.root || params.cwd,
      params.developerInstructions,
      params.dynamicTools
    );
    return { thread: { id }, model: this.session.model };
  }
  async resumeThread(params) {
    await this.resume(params.threadId, params.cwd, params.sandbox, params.developerInstructions);
    return { thread: { id: params.threadId }, model: this.session.model };
  }
  readThread(threadId) {
    const saved = JSON.parse(readFileSync(this.path(threadId), 'utf8'));
    return { thread: { id: threadId, status: { type: saved.status === 'idle' ? 'idle' : 'active' } } };
  }
  emit(method, params) {
    this.onEvent({ method, params: { threadId: this.session.threadId, ...params } });
  }
  checkTurn(threadId, cwd, outputSchema, settings) {
    requireThat(!this.closed, 'This agent connection is closed.');
    requireThat(this.process, 'Open the selected agent connection before sending a prompt.');
    requireThat(!this.process.error, 'The original agent disconnected. Reconcile its session before continuing.');
    requireThat(this.session, 'Open the selected agent conversation before sending a prompt.');
    requireThat(!this.turns.size, 'This agent session already has running work.');
    requireThat(this.session.threadId === threadId, 'Choose the original agent conversation.');
    requireThat(
      this.session.status === 'idle',
      'This agent session is uncertain. Reconcile its original operation before continuing.'
    );
    requireThat(cwd === this.session.cwd, 'Run this conversation in its original checkout.');
    if (settings)
      requireThat(
        agentModel(settings.model).provider === this.selection.provider,
        'Changing agents requires a fresh conversation and an explicit handoff.'
      );
    requireThat(
      !outputSchema,
      'Structured output schemas are not supported by this agent integration. No prompt was sent.'
    );
  }
  prepareTurn(threadId, cwd, prompt, outputSchema, extraInput, settings) {
    try {
      validateTextInput(prompt);
      this.checkTurn(threadId, cwd, outputSchema, settings);
      const prefix = this.selection.provider === 'google' ? this.instructions : '';
      const text = [prefix, prompt, additionalInput(extraInput)].filter(Boolean).join('\n\n');
      validateTextInput(text);
      return text;
    } catch (error) {
      error.turnRejected = true;
      throw error;
    }
  }
  async changeModel(settings) {
    if (!settings) return;
    if (settings.model === this.session.model) return;
    const selection = agentModel(settings.model);
    const commands = {
      anthropic: { method: 'set_model', params: { model: selection.model } },
      google: { method: 'session/set_model', params: { sessionId: this.session.nativeId, modelId: selection.model } },
    };
    const { method, params } = commands[this.selection.provider];
    await this.process.call(method, params);
    this.selection = selection;
    this.retain({ model: settings.model });
  }
  async turn(threadId, cwd, prompt, outputSchema, extraInput = [], settings = null, receipt = null) {
    const text = this.prepareTurn(threadId, cwd, prompt, outputSchema, extraInput, settings);
    const id = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers();
    const turn = { id, text: '', resolve, reject, receipt, started: Promise.resolve({ turn: { id } }) };
    this.turns.set(threadId, turn);
    this.retain({ status: 'running', turnId: id, ownerPid: this.process.child.pid });
    void this.startTurn(turn, text, settings).catch((error) => this.finish(turn, error, !error.turnRejected));
    return promise;
  }
  async startTurn(turn, text, settings) {
    turn.guard = await guardProviderWork(this.root, settings?.model || this.session.model, () =>
      this.interrupt(this.session.threadId)
    );
    if (this.turns.get(this.session.threadId) !== turn) {
      turn.guard.close();
      return;
    }
    assertProviderActive(this.root, this.selection.provider);
    turn.guard.assert();
    await this.changeModel(settings);
    if (this.turns.get(this.session.threadId) !== turn) return;
    assertProviderActive(this.root, this.selection.provider);
    turn.guard.assert();
    turn.dispatched = true;
    this.dispatchPrompt(text, turn);
  }
  dispatchPrompt(text, turn) {
    if (this.selection.provider === 'anthropic') {
      this.process.send({
        type: 'user',
        session_id: this.session.nativeId,
        uuid: turn.id,
        client_composed: true,
        parent_tool_use_id: null,
        message: { role: 'user', content: text },
      });
      return;
    }
    this.process.call('session/prompt', { sessionId: this.session.nativeId, prompt: [{ type: 'text', text }] }, 0).then(
      (result) => {
        this.finishGoogleCommentary(turn);
        if (result.stopReason === 'end_turn') this.finish(turn);
        else this.finish(turn, Error(`The Gemini turn stopped (${result.stopReason}). Continue explicitly.`));
      },
      (error) => this.finish(turn, error, true)
    );
  }
  nativeEvent(message) {
    if (message.type === 'rate_limit_event') this.observeClaudeQuota(message.rate_limit_info);
    if (message.type === 'control_cancel_request') return this.clearRequest(String(message.request_id));
    const turn = this.turns.get(this.session.threadId);
    if (!turn) return;
    const handlers = {
      anthropic: () => this.claudeEvent(message, turn),
      google: () => this.googleEvent(message, turn),
    };
    handlers[this.selection.provider]();
  }
  observeClaudeQuota(info) {
    const type =
      info?.status === 'rejected' && info.errorCode === 'credits_required' ? 'account_credits' : info?.rateLimitType;
    if (!['account_credits', 'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].includes(type)) return;
    const utilization = info.status === 'rejected' ? 1 : info.utilization;
    if (!Number.isFinite(utilization) || utilization < 0 || utilization > 1) return;
    const catalog = providerCatalogs(this.root).anthropic;
    const models =
      type.endsWith('_opus') || type.endsWith('_sonnet')
        ? (catalog?.models || [])
            .filter((entry) => entry.id.includes(type.endsWith('_opus') ? 'opus' : 'sonnet'))
            .map((entry) => entry.id)
        : undefined;
    const window = {
      id: type,
      remainingPercent: Number(((1 - utilization) * 100).toFixed(6)),
      checkedAt: Date.now(),
      resetsAt: info.resetsAt,
      ...(models ? { models } : {}),
    };
    observeProvider(this.root, 'anthropic', {
      quota: {
        complete: false,
        windows: [...(catalog?.quota?.windows || []).filter((entry) => entry.id !== type), window],
      },
    });
  }
  claudeEvent(message, turn) {
    if (message.parent_tool_use_id) return;
    if (['assistant', 'stream_event', 'result'].includes(message.type)) this.acceptTurn(turn);
    const handlers = {
      stream_event: () => this.claudeStream(message.event, turn),
      assistant: () => this.claudeMessage(message.message),
      user: () => this.claudeToolResults(message.message),
      result: () => this.claudeResult(message, turn),
      system: () => this.claudeSystem(message, turn),
    };
    handlers[message.type]?.();
  }
  googleEvent(message, turn) {
    if (message.method !== 'session/update' || message.params.sessionId !== this.session.nativeId) return;
    const update = message.params.update;
    const handlers = {
      agent_message_chunk: () => this.googleText(turn, update.content),
      tool_call: () => {
        this.finishGoogleCommentary(turn);
        this.googleTool(update);
      },
      tool_call_update: () => this.googleTool(update),
    };
    if (!Object.hasOwn(handlers, update.sessionUpdate)) return;
    this.acceptTurn(turn);
    handlers[update.sessionUpdate]();
  }
  googleText(turn, content) {
    if (content.type !== 'text') return;
    turn.segment = (turn.segment || '') + content.text;
    this.delta(turn, content.text);
  }
  finishGoogleCommentary(turn) {
    const text = turn.segment;
    turn.segment = '';
    if (!isChatCommentary({ text })) return;
    turn.text = turn.text.slice(0, -text.length);
    this.emitCommentary(randomUUID(), text);
  }
  googleTool(update) {
    const completed = ['completed', 'failed'].includes(update.status);
    this.emit(completed ? 'item/completed' : 'item/started', {
      item: {
        id: update.toolCallId,
        type: 'dynamicToolCall',
        tool: update.title || update.toolCallId,
        status: update.status,
        arguments: redactValue(update.rawInput),
        output: redactValue(update.rawOutput),
      },
    });
  }
  claudeStream(event, turn) {
    if (event?.delta?.type === 'text_delta') this.delta(turn, event.delta.text);
  }
  emitCommentary(id, text) {
    this.emit('item/completed', { item: { id, type: 'agentMessage', phase: 'commentary', text } });
  }
  claudeMessage(message) {
    const commentary = (message.content || []).filter((entry) => entry.type === 'text' && isChatCommentary(entry));
    for (const [index, { text }] of commentary.entries()) this.emitCommentary(message.id + '-' + index, text);
    this.claudeTools(message);
  }
  claudeTools(message) {
    for (const block of (message.content || []).filter(({ type }) => type === 'tool_use'))
      this.emit('item/started', {
        item: {
          id: block.id,
          type: 'dynamicToolCall',
          tool: block.name,
          arguments: redactValue(block.input),
        },
      });
  }
  claudeToolResults(message) {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content.filter(({ type }) => type === 'tool_result'))
      this.emit('item/completed', {
        item: {
          id: block.tool_use_id,
          type: 'dynamicToolCall',
          status: block.is_error ? 'failed' : 'completed',
          output: redactValue(block.content),
        },
      });
  }
  claudeResult(message, turn) {
    turn.result = message;
    if (message.is_error || ['idle', undefined].includes(this.claudeState)) this.completeClaude(turn);
  }
  claudeSystem(message, turn) {
    if (message.subtype !== 'session_state_changed') return;
    this.claudeState = message.state;
    if (message.state === 'idle' && turn.result) this.completeClaude(turn);
  }
  completeClaude(turn) {
    const result = turn.result;
    if (result.is_error)
      return this.finish(
        turn,
        Error(
          'Claude Code could not complete the turn. Check its login, quota, and model access, then retry explicitly.'
        )
      );
    if (typeof result.result === 'string') turn.text = result.result;
    this.finish(turn);
  }
  delta(turn, text) {
    turn.text += text;
    this.emit('item/agentMessage/delta', { itemId: turn.id, delta: text });
  }
  acceptTurn(turn) {
    if (turn.accepted) return;
    turn.accepted = true;
    turn.receipt?.accepted({ threadId: this.session.threadId, turnId: turn.id });
  }
  retainTerminalState(error, uncertain) {
    this.retain({ status: uncertain ? 'uncertain' : 'idle', error: error?.message || null });
  }
  clearRequests() {
    for (const id of this.requests.keys()) this.clearRequest(id);
  }
  finish(turn, error, uncertain = false) {
    if (this.turns.get(this.session.threadId) !== turn) return;
    try {
      turn.guard?.assert();
    } catch (paused) {
      error = paused;
    }
    turn.guard?.close();
    this.turns.delete(this.session.threadId);
    this.retainTerminalState(error, uncertain);
    this.clearRequests();
    this.emit('turn/completed', { turn: { id: turn.id, status: error ? 'failed' : 'completed' } });
    if (error) turn.reject(terminalError(turn, error, uncertain));
    else turn.resolve(stripChatProgress(turn.text));
  }
  permissionRequest(id, native, command, input, decisions) {
    return {
      id: String(id),
      native,
      method: 'item/commandExecution/requestApproval',
      params: { command, reason: JSON.stringify(redactValue(input)), availableDecisions: [...new Set(decisions)] },
    };
  }
  claudeRequest(message) {
    if (message.request?.subtype !== 'can_use_tool') return null;
    if (message.request.tool_name === 'AskUserQuestion') return this.questionRequest(message);
    return this.permissionRequest(message.request_id, message, message.request.tool_name, message.request.input, [
      'accept',
      'decline',
    ]);
  }
  googleRequest(message) {
    if (message.method !== 'session/request_permission') return null;
    if (message.params.sessionId !== this.session.nativeId) return null;
    const decisions = message.params.options.map(({ kind }) => (kind === 'allow_once' ? 'accept' : 'decline'));
    return this.permissionRequest(
      message.id,
      message,
      message.params.toolCall.title,
      message.params.toolCall.rawInput,
      decisions
    );
  }
  nativeRequest(message) {
    const turn = this.turns.get(this.session.threadId);
    if (!turn) return this.process.rejectRequest(message);
    const request = this.selection.provider === 'anthropic' ? this.claudeRequest(message) : this.googleRequest(message);
    if (!request) return this.process.rejectRequest(message);
    this.acceptTurn(turn);
    Object.assign(request.params, { threadId: this.session.threadId, turnId: turn.id });
    this.requests.set(request.id, request);
    this.emit('ui/approval', { requestId: request.id, method: request.method, ...request.params });
  }
  answer(id, threadId, response) {
    const request = this.requests.get(String(id));
    requireThat(request, 'This permission request is no longer pending.');
    requireThat(request.params.threadId === threadId, 'This permission request is no longer pending.');
    if (request.method === 'item/tool/requestUserInput') return this.answerQuestions(request, response);
    const allow = approvalReply(request, response.decision).decision === 'accept';
    const replies = {
      anthropic: () => this.claudeReply(request, allow),
      google: () => this.googleReply(request, allow),
    };
    this.process.reply(request.native, replies[this.selection.provider]());
    this.clearRequest(String(id));
  }
  claudeReply(request, allow) {
    return allow
      ? { behavior: 'allow', updatedInput: request.native.request.input }
      : { behavior: 'deny', message: 'The user declined this request.' };
  }
  googleReply(request, allow) {
    const kind = allow ? 'allow_once' : 'reject_once';
    const option = request.native.params.options.find((entry) => entry.kind === kind);
    return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
  }
  clearRequest(id) {
    this.requests.delete(id);
    this.emit('serverRequest/resolved', { requestId: id });
  }
  questionRequest(message) {
    const id = String(message.request_id);
    const questions = message.request.input.questions.map((question, index) => ({
      id: 'question-' + index,
      question: question.question,
      header: question.header,
      options: question.options,
      isOther: true,
      isSecret: false,
    }));
    const request = {
      id,
      native: message,
      method: 'item/tool/requestUserInput',
      params: { questions },
    };
    return request;
  }
  answerQuestions(request, response) {
    const answers = Object.fromEntries(
      request.params.questions.map((question) => {
        const answer = response.answers?.[question.id];
        requireThat(typeof answer === 'string' && answer.trim(), 'Answer each question before continuing.');
        return [question.question, answer];
      })
    );
    this.process.reply(request.native, {
      behavior: 'allow',
      updatedInput: {
        ...request.native.request.input,
        answers,
      },
    });
    this.clearRequest(request.id);
  }
  async interrupt(threadId) {
    const turn = this.turns.get(threadId);
    if (!turn) return { interrupted: false };
    if (!turn.dispatched) {
      this.finish(turn, Error('The turn was stopped before its prompt was sent.'));
      return { interrupted: true };
    }
    turn.interruption ||= Promise.resolve().then(async () => {
      if (this.turns.get(threadId) !== turn) return { interrupted: false };
      if (this.selection.provider === 'anthropic') await this.process.call('interrupt');
      else
        this.process.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.session.nativeId } });
      return { interrupted: true };
    });
    return turn.interruption;
  }
  close() {
    this.closed = true;
    this.stopProcess();
    void this.mcp?.close();
  }
}
