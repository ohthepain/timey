import { FactoryUI as LiveFactoryUI } from './factory-ui/service.mjs';

// Protocol fixtures share their explicitly stubbed transport across both callers.
// Production keeps separate connections; no test may silently start a provider.
export class FactoryUI extends LiveFactoryUI {
  constructor(root, options = {}) {
    let service;
    super(root, {
      ...options,
      coordinatorConnection:
        options.coordinatorConnection ||
        (() => ({
          async attach(cwd, state, retain) {
            if (state.threadId) {
              await service.codex.resume(state.threadId, cwd, 'read-only');
              return state.threadId;
            }
            const threadId = await service.codex.start(cwd, 'read-only');
            retain({ threadId });
            return threadId;
          },
          turn: (...args) => service.codex.turn(...args),
          interrupt: (threadId) => service.codex.call('turn/interrupt', { threadId }),
          call: (...args) => service.codex.call(...args),
          close() {},
        })),
    });
    service = this;
    const connect = this.codex.connect.bind(this.codex);
    this.codex.connect = () => {
      if (this.codex.command === 'codex')
        throw Error('Unexpected provider access in a factory test. Inject or stub the connection.');
      return connect();
    };
  }
}
