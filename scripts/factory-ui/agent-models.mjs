import { requireThat } from './common.mjs';

const nativeModels = [
  { id: 'anthropic:sonnet', name: 'Claude Sonnet', provider: 'anthropic', model: 'sonnet', supportsEffort: false },
  { id: 'anthropic:opus', name: 'Claude Opus', provider: 'anthropic', model: 'opus', supportsEffort: false },
  { id: 'google:pro', name: 'Gemini Pro', provider: 'google', model: 'pro', supportsEffort: false },
  { id: 'google:flash', name: 'Gemini Flash', provider: 'google', model: 'flash', supportsEffort: false },
];

export function agentModel(id) {
  const native = nativeModels.find((entry) => entry.id === id);
  if (native) return native;
  requireThat(!id || !id.includes(':'), 'Choose a listed model. Custom providers and endpoints are not supported.');
  return { id, provider: 'codex', model: id, supportsEffort: true };
}

export function sessionProvider(threadId) {
  if (threadId?.startsWith('anthropic:')) return 'anthropic';
  if (threadId?.startsWith('google:')) return 'google';
  return 'codex';
}
