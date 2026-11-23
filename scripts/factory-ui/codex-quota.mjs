import { CodexAccountConnection } from './codex-account.mjs';

const lifetime = 5 * 60 * 1000;
let snapshot;
let pending;

function windowView(window) {
  if (!Number.isFinite(window?.usedPercent)) return null;
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    durationMinutes: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null,
  };
}

function limitView(limit) {
  return {
    id: limit.limitId,
    label: limit.limitName || (limit.limitId === 'codex' ? 'Codex' : limit.limitId) || 'Codex',
    windows: [windowView(limit.primary), windowView(limit.secondary)].filter(Boolean),
  };
}

async function fetchQuota(connect) {
  const connection = connect();
  try {
    await connection.ready();
    const { account } = await connection.call('account/read', { refreshToken: false }, null, 8000);
    if (account?.type !== 'chatgpt') {
      return { status: account?.type === 'apiKey' ? 'api-key' : 'no-chatgpt-account' };
    }
    const result = await connection.call('account/rateLimits/read', {}, null, 8000);
    const buckets = Object.values(result.rateLimitsByLimitId ?? {});
    if (!buckets.length && result.rateLimits) buckets.push(result.rateLimits);
    return {
      status: 'available',
      plan: account.planType ?? null,
      limits: buckets.map(limitView).filter(({ windows }) => windows.length),
    };
  } finally {
    connection.close();
  }
}

export function readCodexQuota({ force = false, connect = () => new CodexAccountConnection() } = {}) {
  if (pending) return pending;
  if (!force && snapshot && Date.now() - snapshot.checkedAt < lifetime) return snapshot;
  pending = fetchQuota(connect)
    .catch(() => ({ status: 'unavailable' }))
    .then((value) => (snapshot = { ...value, checkedAt: Date.now() }))
    .finally(() => {
      pending = undefined;
    });
  return pending;
}
