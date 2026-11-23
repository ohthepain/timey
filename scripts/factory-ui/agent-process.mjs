import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

// The two vendor protocols share framing, but retain their own request envelopes.
export class AgentProcess {
  constructor({ command, args, cwd, env, protocol, event, request }) {
    Object.assign(this, { protocol, event, request });
    this.pending = new Map();
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) =>
      this.fail(
        Object.assign(
          Error(
            error.code === 'ENOENT'
              ? `${command} is not installed. Install the selected agent and sign in through its own CLI, then retry.`
              : `The selected agent could not start (${error.code || 'process error'}).`
          ),
          { code: error.code === 'ENOENT' ? 'AGENT_NOT_INSTALLED' : 'AGENT_START_FAILED' }
        )
      )
    );
    this.child.on('exit', () =>
      this.fail(Error('The selected agent disconnected. Reconcile its original session before retrying.'))
    );
    this.child.stderr.resume();
    this.child.stdout.on('data', (chunk) => this.read(this.decoder.write(chunk)));
  }
  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024)
      return this.fail(Error('The agent protocol message is too large.'));
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.parseLine(line);
    }
  }
  parseLine(line) {
    if (!line.trim()) return;
    if (this.error) return;
    try {
      this.receive(JSON.parse(line));
    } catch {
      this.fail(Error('The agent returned invalid protocol data. No replacement session was started.'));
    }
  }

  receive(message) {
    if (this.protocol === 'claude') return this.receiveClaude(message);
    if (!message.method) return this.receiveReply(message.id, message.result, Boolean(message.error));
    if (message.id === undefined) this.event(message);
    else this.handleRequest(message);
  }
  receiveClaude(message) {
    if (message.type === 'control_response') {
      const response = message.response;
      return this.receiveReply(response.request_id, response.response, response.subtype === 'error');
    }
    if (message.type === 'control_request') this.handleRequest(message);
    else this.event(message);
  }
  handleRequest(message) {
    Promise.resolve()
      .then(() => this.request(message))
      .catch(() => this.rejectRequest(message));
  }
  receiveReply(id, result, failed) {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (failed)
      entry.reject(
        Object.assign(
          Error(
            'The agent rejected the operation. Check its login, model access, and supported version; no fallback was used.'
          ),
          { code: 'AGENT_REJECTED' }
        )
      );
    else entry.resolve(result);
  }
  send(message) {
    if (this.error) throw this.error;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}, timeoutMs = 30000) {
    if (this.error) return Promise.reject(this.error);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(
              Object.assign(
                Error('The agent did not confirm the operation. Reconcile the original session before retrying.'),
                { uncertain: true }
              )
            );
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(
          this.protocol === 'claude'
            ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } }
            : { jsonrpc: '2.0', id, method, params }
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  reply(message, result) {
    this.send(
      this.protocol === 'claude'
        ? {
            type: 'control_response',
            response: { subtype: 'success', request_id: message.request_id, response: result },
          }
        : { jsonrpc: '2.0', id: message.id, result }
    );
  }
  rejectRequest(message) {
    this.send(
      this.protocol === 'claude'
        ? {
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: message.request_id,
              error: 'This client does not support the requested operation.',
            },
          }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported client operation.' } }
    );
  }
  fail(error) {
    if (this.error) return;
    this.error = error;
    error.uncertain = !['AGENT_NOT_INSTALLED', 'AGENT_START_FAILED'].includes(error.code);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.onFailure?.(error);
    this.terminate();
  }
  close() {
    this.fail(Error('The agent connection was closed.'));
    this.terminate();
  }
  terminate() {
    if (!this.child.pid) return;
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
  }
}
