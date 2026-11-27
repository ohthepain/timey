import { effectiveProjectPrompt } from './project-preferences.mjs';
import { readFileSync } from 'node:fs';
import { CodexConnection, interruptCodexTurn } from './codex.mjs';
import { approvalOptions } from './approval-options.mjs';
import { listAvailableSkills, selectedSkills, skillInputs } from './skills.mjs';
import { createProjectDiscussTools } from './project-discuss-tools.mjs';
import { digest, requireThat } from './common.mjs';
import { agentModel, sessionProvider } from './agent-models.mjs';
import { NativeAgentConnection } from './native-agent.mjs';
import { agentRecovery } from './agent-recovery.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopThreadWriter, isCodexWriterConflict, threadLockedMessage } from './codex-thread-writer.mjs';
import { chatProgressInstructions } from './chat-progress.mjs';

const writerRechecks = 45;
const waitForWriter = (signal) => delay(2000, undefined, { signal });

function conversationPromptKind(session, message) {
  if (session.ownership?.kind === 'issue') return 'issue';
  return message.reportContext ? 'report' : 'project';
}

function discussionPrompt(session, message, issueContext) {
  const parts = [];
  if (issueContext) parts.push('Selected issue request and current flow status:\n' + JSON.stringify(issueContext));
  if (session.noteContext) parts.push('Local note context:\n' + JSON.stringify(session.noteContext));
  if (message.reportContext) parts.push(...reportPrompt(session, message));
  parts.push('Current request:\n' + message.text);
  parts.push(
    'When the next step depends on a concrete scope decision or an available skill, you may append a fenced timey-recommendations JSON object with recommendations (items with label and prompt). Use Refine scope only for a concrete open scope decision, or use the relevant available skill name as the label. For note discussion include grillingComplete: true only once the work of the selected grilling skill is finished.'
  );
  return parts.join('\n\n');
}

function reportPrompt(session, message) {
  const parts = [];
  parts.push(
    'Selected retained investigation report context. Earlier messages retain their original report. Discussion never restores or starts the source investigation. Follow-up issues use the existing guarded tools and require approval.\n' +
      JSON.stringify(message.reportContext)
  );
  parts.push(
    'Retained investigation conversation history:\n' +
      JSON.stringify(
        session.messages
          .filter((entry) => entry.imported || entry.status === 'historical')
          .map(({ role, text, reportContext, investigationContext }) => ({
            role,
            text,
            reportContext,
            investigationContext,
          }))
      )
  );
  return parts;
}

function issueDiscussPermissions(kind) {
  if (kind !== 'issue') return '';
  return '\nIn Issue Discuss, the person may explicitly request file edits under the same workspace permissions and approval controls as Project Discuss. For all other requests, keep shell access read-only. Use the existing guarded tools for issue operations.';
}

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
    this.flows = options.flows;
    this.injectedConnection = Boolean(options.connection);
    this.tools =
      options.tools ||
      createProjectDiscussTools(service, {
        ...options,
        reportContext: () => this.active?.message.reportContext,
        prepareIssueCreation: (input) => this.active?.prepareIssueCreation?.(input),
        issueCreated: (issueId) => this.active?.issueCreated?.(issueId),
        beforeNoteChange: (input) => this.beforeNoteChange(input),
        annotationActor: () => ({ kind: 'chat', id: this.active?.session.id }),
      });
    this.connection = options.connection || new DiscussConnection({ experimentalApi: true, root: service.root });
    this.connection.toolHandler = (params) => this.invokeTool(params);
    this.connection.onEvent = (event) => this.event(event);
    this.active = null;
    this.threadWriterOwner = options.threadWriterOwner ?? desktopThreadWriter;
    this.threadWriterDelay = options.threadWriterDelay ?? waitForWriter;
  }
  beforeNoteChange({ action }) {
    if (action !== 'delete') return;
    requireThat(
      this.active?.message.recommendation?.id !== 'create-delete-next',
      'Factory deletes the source note after confirming issue creation.'
    );
  }
  async skills(model, scope) {
    if (!model || agentModel(model).provider === 'codex')
      return listAvailableSkills(this.connection, this.service.root, scope);
    const connection = new NativeAgentConnection({ root: this.service.root, model });
    try {
      return await listAvailableSkills(connection, this.service.root, scope);
    } finally {
      connection.close();
    }
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
    const abort = () => {
      void this.stop(session).catch(() => {});
    };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      context.signal.throwIfAborted();
      const input = await this.prepareConversation(session, message);
      const connection = this.connection;
      context.signal.throwIfAborted();
      const output = await connection.turn(
        session.threadId,
        this.service.root,
        discussionPrompt(session, this.active.message, this.issueContext(session)),
        undefined,
        input,
        message.settings,
        {
          clientId: message.id,
          accepted: ({ turnId }) => this.retain({ turnId }),
        }
      );
      return parseResponse(output);
    } catch (error) {
      this.resetRejectedStartup(error, session);
      throw error;
    } finally {
      context.signal.removeEventListener('abort', abort);
      this.active = null;
    }
  }
  resetRejectedStartup(error, session) {
    if (!error.turnRejected) return;
    if (session.threadId) return;
    this.retain({ startup: null });
  }
  issueContext(session) {
    if (session.ownership?.kind !== 'issue') return null;
    const flows = this.flows();
    const issue = flows.selected(session.ownership.issueId);
    const flow = flows.read(issue);
    return {
      id: issue.id,
      title: issue.title,
      state: issue.state,
      wording: flow.blocks.find(({ kind }) => kind === 'request')?.data?.wording,
      blocks: flow.blocks.map(({ id, label, attempts }) => {
        const current = attempts.findLast((attempt) => !attempt.invalidatedAt);
        return { id, label, status: current?.status || 'idle', summary: current?.summary };
      }),
    };
  }
  async selectedInputs(session, message) {
    const available = await this.skills();
    const selected = selectedSkills(available, message.settings.skills || []);
    const clarification = available.find((skill) => skill.name === message.settings.clarificationSkill);
    requireThat(
      message.settings.clarificationSkill === 'none' || clarification,
      'The selected clarification skill is unavailable. Choose No Grilling or set up skills.'
    );
    return {
      inputs: skillInputs(selected),
      instructions: this.instructions(available, clarification, conversationPromptKind(session, message)),
    };
  }
  async prepareConversation(session, message) {
    if (!this.injectedConnection) await this.selectAgent(session, message.settings);
    const { inputs, instructions } = await this.selectedInputs(session, message);
    this.active.signal.throwIfAborted();
    await this.attach(session, message.settings, instructions);
    return [...inputs, ...attachmentInputs(message.attachments || [])];
  }
  async selectAgent(session, settings) {
    const target = agentModel(settings.model).provider;
    await this.handoff(session, target);
    if ((this.connection.selection?.provider || 'codex') === target) return;
    this.connectAgent(target, settings);
  }
  async requireHandoffIdle(session) {
    requireThat(
      !agentRecovery(this.service.root, session.threadId),
      'Recover the original agent session before handing off its work to another agent.'
    );
    if (sessionProvider(session.threadId) === 'codex') {
      await this.connection.ready();
      const { thread } = await this.connection.call('thread/read', { threadId: session.threadId, includeTurns: false });
      requireThat(thread.status?.type === 'idle', 'Stop or reconcile the original conversation before handing off.');
    }
  }
  async handoff(session, target) {
    if (!session.threadId) return;
    if (sessionProvider(session.threadId) === target) return;
    await this.requireHandoffIdle(session);
    const handoff = {
      threadId: session.threadId,
      at: new Date().toISOString(),
      summary:
        `Full retained history: ${this.service.root}/.issues/factory-ui/project-discuss/${session.id}/conversation.json\nRecent conversation excerpt:\n` +
        session.messages
          .map(({ role, text }) => `${role}: ${text}`)
          .join('\n\n')
          .slice(-24000),
    };
    this.retain({
      priorConversations: [...(session.priorConversations || []), handoff],
      threadId: null,
      turnId: null,
      startup: null,
    });
    this.active.message = {
      ...this.active.message,
      text: `Conversation handoff from ${handoff.threadId}. Retained context:\n${handoff.summary}\n\nCurrent request:\n${this.active.message.text}`,
    };
  }
  connectAgent(target, settings) {
    this.connection.close();
    this.connection =
      target === 'codex'
        ? new DiscussConnection({ experimentalApi: true, root: this.service.root })
        : new NativeAgentConnection({
            root: this.service.root,
            model: settings.model,
            toolDefinitions: this.tools.definitions,
          });
    this.connection.toolHandler = (params) => this.invokeTool(params);
    this.connection.onEvent = (event) => this.event(event);
  }
  instructions(available, clarification, kind = 'project') {
    const catalogue = available
      .filter((skill) => skill.allowImplicitInvocation !== false)
      .map(({ name, description, path }) => ({ name, description, path }));
    return (
      effectiveProjectPrompt(this.service.root, kind) +
      issueDiscussPermissions(kind) +
      '\n\n' +
      chatProgressInstructions +
      '\n\nWhen creating an issue from this conversation, write issue_create.description as the future work: the agreed problem or change, scope, product constraints, decisions, acceptance criteria and requested proof. Keep instructions about this creation operation, such as "create the issue only", "leave it idle" or "do not start implementation now", in this conversation and the creation receipt, outside the saved work description. The creation tool already leaves the issue idle. Preserve genuine prerequisites and required human approvals in the description. For example, "Create an idle issue to replace the gear menu with project Settings" becomes "Replace the gear menu with project Settings", followed by the agreed requirements and implementation proof. Report the creation result without starting work unless separately requested.' +
      (clarification
        ? '\nExplicitly chosen clarification skill (invoke only for unresolved ambiguity): ' +
          JSON.stringify({ name: clarification.name, path: clarification.path })
        : '\nNo Grilling: do not invoke a clarification or grilling skill. Ask ordinary questions only when needed.') +
      '\nProject skill dependencies (read when invoked by a selected skill, not for unrestricted implicit selection): ' +
      JSON.stringify(
        available
          .filter((skill) => skill.source === 'Project' || skill.source === 'Factory')
          .map(({ name, path }) => ({ name, path }))
      ) +
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
      const resume = () =>
        connection.call('thread/resume', { ...params, threadId: session.threadId, excludeTurns: true });
      await this.resumeThread(session.threadId, resume);
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

  async resumeThread(threadId, resume) {
    if (sessionProvider(threadId) !== 'codex') return resume();
    const signal = this.active.signal;
    let notice;
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          return await resume();
        } catch (error) {
          if (!isCodexWriterConflict(error.message)) throw error;
          if (attempt === writerRechecks) {
            const current = threadLockedMessage(await this.threadWriterOwner(threadId));
            throw Error(current + ' Retry after that session releases the conversation.');
          }
        }
        if (!notice) {
          notice = threadLockedMessage(await this.threadWriterOwner(threadId));
          this.retain({ threadLock: notice + ' Factory will retry automatically. Use Stop to cancel the wait.' });
        }
        await this.threadWriterDelay(signal);
      }
    } finally {
      if (notice) this.retain({ threadLock: null });
    }
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

function parseRecommendations(body) {
  const matched = body.match(/\n?```timey-recommendations\s*\n([\s\S]*?)\n```\s*$/);
  if (!matched) return { body };
  try {
    const value = JSON.parse(matched[1]);
    return {
      body: body.slice(0, matched.index).trimEnd(),
      recommendations: (value.recommendations || [])
        .slice(0, 4)
        .filter(({ label, prompt }) => typeof label === 'string' && typeof prompt === 'string')
        .map(({ label, prompt }, index) => ({
          id: 'context-' + index,
          label: label.slice(0, 40),
          prompt: prompt.slice(0, 2000),
        })),
      grillingComplete: value.grillingComplete === true,
    };
  } catch {
    return { body: body.slice(0, matched.index).trimEnd() };
  }
}

function parseResponse(output) {
  const { body, ...context } = parseRecommendations(String(output));
  const match = body.match(/\n?```timey-suggestion\s*\n([\s\S]*?)\n```\s*$/);
  return {
    ...context,
    text: match ? body.slice(0, match.index).trimEnd() : body,
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
