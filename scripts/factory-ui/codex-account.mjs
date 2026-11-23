import { AgentProcess } from './agent-process.mjs';
import { cleanEnvironment, requireThat } from './common.mjs';

// Metadata-only connection: it cannot start an AI turn or alter sign-in.
export class CodexAccountConnection {
  async ready() {
    if (!this.starting) this.starting = this.initialize();
    return this.starting;
  }
  async initialize() {
    this.process = new AgentProcess({
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      cwd: process.cwd(),
      env: cleanEnvironment(),
      protocol: 'codex',
      event() {},
      request() {
        throw Error('Account inspection cannot grant permissions.');
      },
    });
    const result = await this.call('initialize', {
      clientInfo: { name: 'timey_provider_settings', version: '1' },
      capabilities: { experimentalApi: false },
    });
    this.process.send({ method: 'initialized' });
    return result;
  }
  call(method, params, _onSlow = null, timeoutMs = 15000) {
    requireThat(
      ['initialize', 'account/read', 'account/rateLimits/read', 'model/list'].includes(method),
      'Provider discovery supports account and model metadata only.'
    );
    return this.process.call(method, params, timeoutMs);
  }
  close() {
    this.process?.close();
  }
}
