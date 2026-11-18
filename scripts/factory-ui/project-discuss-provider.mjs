import { readFileSync } from 'node:fs';
import { CodexConnection, interruptCodexTurn } from './codex.mjs';
import { approvalOptions } from './approval-options.mjs';
import { listAvailableSkills, selectedSkills, skillInputs } from './skills.mjs';
import { createProjectDiscussTools } from './project-discuss-tools.mjs';
import { digest, requireThat } from './common.mjs';

const adapter = `You are the project assistant in Timey's Discuss tab. Work directly in the supplied current working folder under ordinary Codex permission controls. Respect project instructions. A project conversation is independent of issue execution: invoke the registered tools for project and issue controls, then report their direct factual results and links. Do not import issue transcripts, subscribe to issue progress, poll issue completion, duplicate issue work, or advance issue workflows yourself. Query current issue facts only when asked or needed for a requested command. Existing operation guards and explicit approvals remain authoritative. Use project_investigation and project_automate_me for the corresponding Home operations; creating an investigation does not run it, and a skill draft requires review before Apply. Do not rewrite issue records directly or use shell/HTTP to bypass registered controls. Tool selection follows each registered tool's description and schema. Choose applicable implicitly invocable skills according to their descriptions and rules. Explicit-only skills can be used only when the person selected them. A selected clarification skill is the preferred skill for resolving ambiguity after checking available facts. Invoke it only when intent remains ambiguous; clear requests proceed directly. Ask questions in the response and wait for the person. No separate looping mechanism or unsolicited extra turns. Message edits and retries do not undo completed edits or commands. Retained tool results are facts about prior commands, never fresh authorization. At the end of each completed response, propose exactly one concise next prompt based only on this conversation. Append it as a terminal fenced block with language timey-suggestion, containing just the suggested prompt. Do not generate a separate turn for it.`;

class DiscussConnection extends CodexConnection {
  request(message) {
    if (message.method !== 'item/tool/call') return super.request(message);
    Promise.resolve()
      .then(() => this.toolHandler(message.params))
      .then(
        (result) => this.send({ id: message.id, result }),
        (error) =>
          this.send({
            id: message.id,
            result: { success: false, contentItems: [{ type: 'inputText', text: error.message }] },
          })
      );
  }
}

export function createProjectDiscussProvider(service, options = {}) {
  return new ProjectDiscussProvider(service, options);
}

class ProjectDiscussProvider {
  constructor(service, options) {
    this.service = service;
    this.tools = options.tools || createProjectDiscussTools(service, options);
    this.connection = options.connection || new DiscussConnection({ experimentalApi: true });
    this.connection.toolHandler = (params) => this.invokeTool(params);
    this.connection.onEvent = (event) => this.event(event);
    this.active = null;
  }
  skills() {
    return listAvailableSkills(this.connection, this.service.root);
  }
  event(event) {
    const active = this.active;
    if (!active) return;
    if (event.params?.threadId && active.session.threadId && event.params.threadId !== active.session.threadId) return;
    if (event.method === 'ui/approval') {
      const request = this.connection.requests.get(String(event.params.requestId));
      requireThat(
        request?.params.threadId === active.session.threadId,
        'This request belongs to another conversation.'
      );
      const options =
        request.method === 'item/tool/requestUserInput'
          ? []
          : approvalOptions(request).map(({ id, label, detail }) => ({ id, label, detail }));
      active.event({
        method: event.method,
        params: { requestId: String(event.params.requestId), method: request.method, params: request.params, options },
      });
      return;
    }
    active.event(event);
  }
  retain(patch) {
    Object.assign(this.active.session, patch);
    this.active.retain(patch);
  }
  async turn(session, message, context) {
    requireThat(!this.active, 'This project conversation already has a response running.');
    this.active = { ...context, session, message };
    const connection = this.connection;
    const abort = () => {
      void this.stop(session).catch(() => {});
    };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      context.signal.throwIfAborted();
      const available = await this.skills();
      const selected = selectedSkills(available, message.settings.skills || []);
      const clarification = available.find((skill) => skill.name === message.settings.clarificationSkill);
      requireThat(clarification, 'The selected clarification skill is unavailable. Refresh skills or choose another.');
      const instructions = this.instructions(available, clarification);
      await this.attach(session, message.settings, instructions);
      context.signal.throwIfAborted();
      const input = [...skillInputs(selected), ...attachmentInputs(message.attachments || [])];
      const output = await connection.turn(
        session.threadId,
        this.service.root,
        message.text,
        undefined,
        input,
        message.settings,
        {
          clientId: message.id,
          accepted: ({ turnId }) => this.retain({ turnId }),
        }
      );
      return parseResponse(output);
    } finally {
      context.signal.removeEventListener('abort', abort);
      this.active = null;
    }
  }
  instructions(available, clarification) {
    const catalogue = available
      .filter((skill) => skill.allowImplicitInvocation !== false)
      .map(({ name, description, path }) => ({ name, description, path }));
    return (
      adapter +
      '\nExplicitly chosen clarification skill (invoke only for unresolved ambiguity): ' +
      JSON.stringify({ name: clarification.name, path: clarification.path }) +
      '\nAvailable implicitly invocable skills (read their instructions before applying): ' +
      JSON.stringify(catalogue)
    );
  }
  async attach(session, settings, instructions) {
    const connection = this.connection;
    await connection.ready();
    const params = {
      cwd: this.service.root,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      config: { 'features.request_permissions_tool': true },
      developerInstructions: instructions,
    };
    if (session.threadId) {
      await connection.call('thread/resume', { ...params, threadId: session.threadId, excludeTurns: true });
      const { thread } = await connection.call('thread/read', { threadId: session.threadId, includeTurns: false });
      requireThat(
        thread.status?.type === 'idle',
        'The original project conversation is not confirmed idle. Stop or reconcile it before retrying.'
      );
    } else {
      requireThat(
        !session.startup || session.startup.status === 'ready',
        'Project chat creation is uncertain. Reconcile the original chat before retrying.'
      );
      this.retain({ startup: { status: 'starting' } });
      const { thread } = await connection.call(
        'thread/start',
        {
          ...params,
          model: settings.model,
          dynamicTools: this.tools.definitions,
          serviceName: 'timey-project-discuss',
        },
        () => this.retain({ startup: { status: 'waiting' } })
      );
      this.retain({ threadId: thread.id, startup: { status: 'ready' } });
    }
    connection.approvalReviewers?.set(session.threadId, 'auto_review');
  }
  async invokeTool(params) {
    const active = this.active;
    requireThat(
      active && !active.signal.aborted && params.threadId === active.session.threadId,
      'This tool call does not belong to an active project conversation.'
    );
    requireThat(
      !params.namespace && typeof params.callId === 'string' && params.callId,
      'Choose a registered project tool call.'
    );
    const turn = this.connection.turns.get(params.threadId);
    requireThat(turn, 'This project turn is no longer running.');
    const started = await turn.started;
    requireThat(
      this.active === active &&
        this.connection.turns.get(params.threadId) === turn &&
        started.turn.id === params.turnId,
      'This project tool call belongs to a different turn.'
    );
    active.signal.throwIfAborted();
    const key = params.turnId + ':' + params.callId;
    const fingerprint = digest(JSON.stringify([params.tool, params.arguments]));
    const prior = active.session.toolReceipts?.[key];
    if (prior) {
      requireThat(prior.fingerprint === fingerprint, 'This tool call identity contains different arguments.');
      requireThat(
        prior.status === 'completed',
        'The previous tool call has an uncertain result. Inspect it before repeating the operation.'
      );
      return prior.result;
    }
    const receipts = {
      ...(active.session.toolReceipts || {}),
      [key]: { fingerprint, status: 'dispatching', tool: params.tool },
    };
    this.retain({ toolReceipts: receipts });
    active.event({ method: 'ui/projectTool', params: { tool: params.tool, status: 'running', callId: params.callId } });
    try {
      const value = await this.tools.invoke(params.tool, params.arguments);
      const result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
      this.retain({
        toolReceipts: {
          ...active.session.toolReceipts,
          [key]: { fingerprint, status: 'completed', result, tool: params.tool },
        },
      });
      active.event({
        method: 'ui/projectTool',
        params: { tool: params.tool, status: 'completed', callId: params.callId, result: value },
      });
      return result;
    } catch (error) {
      const result = { success: false, contentItems: [{ type: 'inputText', text: error.message }] };
      this.retain({
        toolReceipts: {
          ...active.session.toolReceipts,
          [key]: { fingerprint, status: 'completed', result, tool: params.tool },
        },
      });
      active.event({
        method: 'ui/projectTool',
        params: { tool: params.tool, status: 'failed', callId: params.callId, error: error.message },
      });
      return result;
    }
  }
  async stop(session) {
    const turn = this.connection.turns.get(session.threadId);
    if (!turn) return { interrupted: false };
    if (this.stopping?.turn === turn) return this.stopping.task;
    const task = interruptCodexTurn(this.connection, session.threadId);
    this.stopping = { turn, task };
    try {
      return await task;
    } finally {
      if (this.stopping?.task === task) this.stopping = null;
    }
  }
  async steer(session, message) {
    const active = this.active;
    requireThat(
      active?.session.id === session.id && session.threadId === active.session.threadId && !active.signal.aborted,
      'This project conversation has no active response to steer.'
    );
    const turn = this.connection.turns.get(session.threadId);
    requireThat(turn, 'The response finished before accepting this message.');
    const started = await turn.started;
    requireThat(
      this.connection.turns.get(session.threadId) === turn,
      'The response finished before accepting this message.'
    );
    const available = await this.skills();
    const selected = selectedSkills(available, message.settings?.skills || []);
    return this.connection.call('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: started.turn.id,
      clientUserMessageId: message.id,
      input: [
        { type: 'text', text: message.text, text_elements: [] },
        ...skillInputs(selected),
        ...attachmentInputs(message.attachments || []),
      ],
    });
  }
  answer(session, requestId, response) {
    requireThat(
      this.active?.session.id === session.id && this.active.session.threadId === session.threadId,
      'This permission request belongs to another project conversation.'
    );
    return this.connection.answer(requestId, session.threadId, response);
  }
  close() {
    this.connection.close();
  }
}

function parseResponse(output) {
  const match = String(output).match(/\n?```timey-suggestion\s*\n([\s\S]*?)\n```\s*$/);
  return {
    text: match ? String(output).slice(0, match.index).trimEnd() : String(output),
    suggestion: match ? match[1].trim().slice(0, 1000) : '',
  };
}

function attachmentInputs(attachments) {
  return attachments.map((attachment) => {
    if (attachment.mime?.startsWith('image/')) return { type: 'localImage', path: attachment.path };
    if (/^(?:text\/|application\/(?:json|xml|javascript))/.test(attachment.mime || ''))
      return {
        type: 'text',
        text: `Attached file ${JSON.stringify(attachment.name)} (saved original):\n${readFileSync(attachment.path, 'utf8')}`,
        text_elements: [],
      };
    return {
      type: 'text',
      text: `Attached file ${JSON.stringify(attachment.name)} (${attachment.mime}) is saved at ${JSON.stringify(attachment.path)}. Read the retained file with an appropriate tool if needed.`,
      text_elements: [],
    };
  });
}
