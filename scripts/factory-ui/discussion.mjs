import { installedGrilling, grillingStage, beginGrilling, previewGrilling } from './discussion-grilling.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readQueue } from './data.mjs';
import { digest, requireThat } from './common.mjs';
import { createDiscussionRuntime } from './discussion-codex.mjs';
import { recordDiscussion } from './discussion-record.mjs';

const idle = 15 * 60 * 1000,
  lifetime = 60 * 60 * 1000;
export function createDiscussions(
  service,
  create = createDiscussionRuntime,
  now = Date.now,
  skill = installedGrilling
) {
  const manager = {
    service,
    skill,
    create,
    now,
    sessions: new Map(),
    open(input, owner) {
      this.sweep();
      requireThat(this.sessions.size < 8, 'End another discussion before starting a new one.');
      const context = this.context(input.issueId);
      const session = {
        id: randomUUID(),
        owner,
        issueId: input.issueId,
        basis: context.basis,
        created: this.now(),
        touched: this.now(),
        runtime: null,
        busy: false,
        intents: new Map(),
        turns: 0,
        answers: [],
      };
      this.sessions.set(session.id, session);
      return { session: session.id };
    },
    context(id) {
      const queue = readQueue(this.service.root);
      const issue = queue.issues.find((item) => item.id === id);
      requireThat(issue, 'Select an existing issue.');
      const policy = ['docs/agents/operating.md', 'docs/agents/verification.md', '.issues/preferences.json'].map(
        (file) => (existsSync(join(this.service.root, file)) ? readFileSync(join(this.service.root, file), 'utf8') : '')
      );
      const context = {
        issue: { id: issue.id, title: issue.title, state: issue.state, content: issue.content },
        lifecycle: queue.lifecycle,
        policy,
      };
      return {
        queue,
        issue,
        context,
        basis: digest(JSON.stringify({ context, head: queue.head, snapshot: queue.snapshot.worktree })),
      };
    },
    get(input, owner) {
      this.sweep();
      const session = this.sessions.get(input.session);
      requireThat(
        session && session.owner === owner && session.issueId === input.issueId,
        'Discussion expired or belongs to another page.'
      );
      const context = this.context(input.issueId);
      if (session.basis !== context.basis) {
        this.drop(session);
        throw Error('Issue or policy changed. Start a fresh temporary discussion.');
      }
      session.touched = this.now();
      return { session, ...context };
    },
    async turn(input, owner, internal = false) {
      const { session, context } = this.get(input, owner);
      validateTurn(session, input.text);
      session.busy = true;
      session.turns++;
      try {
        await this.ensureRuntime(session, context);
        const text = await session.runtime.ask(input.text, internal ? session.skill : null);
        this.get(input, owner);
        requireThat(typeof text === 'string' && text.length <= 32000, 'Discussion response exceeded its limit.');
        retainActualAnswer(session, input.text, internal);
        session.intents.clear();
        return { text };
      } catch {
        this.drop(session);
        throw Error('Discussion ended or could not complete. Start a fresh temporary discussion.');
      } finally {
        session.busy = false;
      }
    },
    async ensureRuntime(session, context) {
      if (session.runtime) return;
      session.runtime = this.create(() => this.drop(session));
      await session.runtime.begin(context);
    },
    prepare(input, owner) {
      const { session, queue, issue } = this.get(input, owner);
      requireThat(!session.busy, 'Wait for this response to finish.');
      requireThat(['record', 'grill'].includes(input.kind), 'Choose a named discussion action.');
      const text = input.kind === 'record' ? input.text : '';
      validateSelection(input.kind, text);
      session.intents.clear();
      const token = randomUUID();
      const stage = input.kind === 'grill' ? grillingStage(queue, issue, input.stageState) : null;
      session.intents.set(token, { kind: input.kind, text, stage, hash: digest(text), expires: this.now() + 120000 });
      return {
        token,
        kind: input.kind,
        text,
        issueId: session.issueId,
        stage,
        effect:
          input.kind === 'record'
            ? 'Append only this selected text as human-approved discussion output. No stage change, approval or completed grilling.'
            : 'Start a temporary structured interview here. No transcript or grilling outcome is saved.',
      };
    },
    async commit(input, owner) {
      requireThat(input.clicked === true, 'Use the named confirmation control.');
      const { session, queue, issue } = this.get(input, owner);
      const intent = session.intents.get(input.token);
      session.intents.delete(input.token);
      requireThat(intent && intent.expires > this.now(), 'Review this action again before confirming.');
      if (intent.kind === 'record') return recordDiscussion(this.service, queue, issue, intent);
      if (intent.kind === 'stage-record') return saveStageInterview(this, session, queue, issue, intent, input);
      return beginGrilling(this, session, intent.stage, input, owner);
    },
    summarize(input, owner) {
      return previewGrilling(this, input, owner);
    },

    end(input, owner) {
      const session = this.sessions.get(input.session);
      if (session && session.owner === owner && session.issueId === input.issueId) this.drop(session);
      return { ended: true };
    },
    drop(session) {
      this.sessions.delete(session.id);
      session.intents.clear();
      const runtime = session.runtime;
      session.runtime = null;
      runtime?.close();
    },
    sweep() {
      for (const session of this.sessions.values())
        if (this.now() - session.touched >= idle || this.now() - session.created >= lifetime) this.drop(session);
    },
    close() {
      clearInterval(this.timer);
      for (const session of this.sessions.values()) this.drop(session);
    },
  };
  manager.timer = setInterval(() => manager.sweep(), 30000);
  manager.timer.unref();
  return manager;
}

function validateTurn(session, text) {
  requireThat(!session.busy, 'Wait for this turn to finish.');
  requireThat(session.turns < 40, 'Discussion reached its limit. End it to start again.');
  requireThat(
    typeof text === 'string' && text.trim() && text.length <= 8000,
    'Enter a message under 8,000 characters.'
  );
}
function validateSelection(kind, text) {
  requireThat(typeof text === 'string' && text.length <= 8000, 'Select output under 8,000 characters.');
  if (kind === 'record') requireThat(text.trim(), 'Select output to record.');
}

function retainActualAnswer(session, text, internal) {
  if (!internal) session.answers.push(text);
}
function saveStageInterview(manager, session, queue, issue, intent, input) {
  requireThat(!session.busy, 'Wait for this response to finish.');
  requireThat(!input.continue || intent.canContinue, 'Continue only from the current unfinished step.');
  const saved = recordDiscussion(manager.service, queue, issue, intent, input.continue === true);
  manager.drop(session);
  return saved;
}
