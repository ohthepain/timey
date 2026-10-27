import { retainStreamEvent, recoverStream } from './run-stream.mjs';
import { activityForRun, redactValue } from './activity.mjs';
import { approvalOptions } from './approval-options.mjs';
import { existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './common.mjs';

export class RunStore {
  constructor(root, authorization = () => null) {
    this.authorization = authorization;
    this.directory = join(root, '.issues/factory-ui');
    this.path = join(this.directory, 'runs.json');
    this.reload();
    this.connected = new Set();
  }
  reload() {
    const history = existsSync(this.path) ? readJson(this.path) : { version: 1, runs: [] };
    if (history.version !== 1) throw Error('Unsupported UI history. Reconcile it before proceeding.');
    this.runs = history.runs;
    if (!Array.isArray(this.runs)) throw Error('Damaged UI run history. Reconcile it; do not reset it.');
    for (const run of this.runs.filter((r) => ['preparing', 'running', 'checking'].includes(r.status)))
      recoverStream(run, join(this.directory, `${run.id}.jsonl`));
  }
  flush() {
    if (this.streamSave) this.save();
  }
  save() {
    clearTimeout(this.streamSave);
    this.streamSave = null;
    mkdirSync(this.directory, { recursive: true });
    writeJson(this.path, { version: 1, runs: this.runs });
  }
  add(action, kind, base) {
    const run = {
      id: randomUUID(),
      actionId: action.id,
      authorization: this.authorization(action, kind),
      kind,
      base,
      candidate: action.worker_revision || null,
      status: 'preparing',
      created: new Date().toISOString(),
      events: [],
      streamOffset: 0,
      summary: 'Preparing the conversation.',
    };
    this.runs.push(run);
    this.connected.add(run.id);
    this.save();
    return run;
  }
  update(run, values) {
    if (values.issueId)
      values.authorization =
        run.authorization?.kind === 'approved-plan'
          ? run.authorization
          : this.authorization({ ...run, ...values }, run.kind);
    Object.assign(run, values, { updated: new Date().toISOString() });
    this.save();
  }
  event(message) {
    const run = this.runs.findLast((r) => r.threadId === message.params?.threadId && this.connected.has(r.id));
    if (!run) return;
    const events = [
      'item/agentMessage/delta',
      'item/commandExecution/outputDelta',
      'item/started',
      'item/completed',
      'turn/started',
      'turn/completed',
      'ui/approval',
      'ui/unsupportedRequest',
      'item/autoApprovalReview/started',
      'item/autoApprovalReview/completed',
    ];
    if (!events.includes(message.method)) return;
    const item = { at: new Date().toISOString(), ...redactValue(message) };
    const path = join(this.directory, `${run.id}.jsonl`);
    if (!Number.isSafeInteger(run.streamOffset)) run.streamOffset = existsSync(path) ? statSync(path).size : 0;
    const line = JSON.stringify(item) + '\n';
    appendFileSync(path, line, { mode: 0o600 });
    run.streamOffset += Buffer.byteLength(line);
    retainStreamEvent(run, item);
    if (!message.method.endsWith('/delta') && !message.method.endsWith('/outputDelta')) return this.save();
    if (!this.streamSave) this.streamSave = setTimeout(() => this.save(), 1000).unref();
  }
  list(approvals) {
    return this.runs.map((run) => ({
      ...run,
      output: activityForRun(run),
      events: redactValue(run.events),
      connected: this.connected.has(run.id),
      approvals: [...approvals.values()]
        .filter((r) => r.params.threadId === run.threadId)
        .map((r) => ({
          id: String(r.id),
          method: r.method,
          params: redactValue(r.params),
          options:
            r.method === 'item/tool/requestUserInput'
              ? []
              : approvalOptions(r).map(({ id, label, detail }) => ({ id, label, detail: redactValue(detail) })),
        })),
    }));
  }
}
