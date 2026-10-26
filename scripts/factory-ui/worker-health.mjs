// Status checks use the SAME app-server connection that owns the live turn.
// Quiet output or persisted history from another connection cannot prove it stopped.
export function installWorkerHealth(service) {
  if (service.workerHealth) return service.workerHealth;
  const connection = service.codex,
    states = new Map();
  const event = connection.event.bind(connection);
  connection.event = (message) => {
    observe(states, connection, message);
    return event(message);
  };
  const snapshot = service.snapshot.bind(service);
  service.snapshot = (...args) => {
    const data = snapshot(...args);
    return { ...data, runs: data.runs.map((run) => ({ ...run, health: healthFor(connection, states, run) })) };
  };
  let pending;
  const check = () =>
    (pending ||= checkTurns(connection, states).finally(() => {
      pending = null;
    }));
  const timer = setInterval(() => {
    void check();
  }, 30000);
  timer.unref();
  const close = service.close.bind(service);
  service.close = () => {
    clearInterval(timer);
    return close();
  };
  service.workerHealth = { check };
  return service.workerHealth;
}
function stateFor(states, id) {
  return states.get(id) || { activitySerial: 0 };
}
function observe(states, connection, message) {
  const params = message.params || {},
    id = params.threadId;
  if (!connection.turns.has(id)) return;
  const state = stateFor(states, id);
  state.lastActivityAt = new Date().toISOString();
  state.activitySerial++;
  states.set(id, state);
  if (message.method === 'turn/started') connection.turns.get(id).id = params.turn.id;
}
function eventTime(run) {
  const event = (run.events || []).at(-1);
  return event ? event.at : null;
}
function healthFor(connection, states, run) {
  const health = stateFor(states, run.threadId);
  const lastActivityAt = health.lastActivityAt || eventTime(run);
  if (hasRequest(connection, run.threadId)) return { ...health, lastActivityAt, state: 'waiting' };
  return { ...health, lastActivityAt, state: health.state || 'unconfirmed' };
}
function hasRequest(connection, id) {
  return [...connection.requests.values()].some((r) => r.params.threadId === id);
}
async function checkTurns(connection, states) {
  const checks = [...connection.turns].map(([id, turn]) => checkTurn(connection, states, id, turn));
  await Promise.allSettled(checks);
}
async function checkTurn(connection, states, id, turn) {
  const serial = stateFor(states, id).activitySerial;
  try {
    const { thread } = await connection.call('thread/read', { threadId: id, includeTurns: true });
    adoptLiveTurn(turn, thread);
    applyStatus(connection, states, id, turn, thread, serial);
  } catch {
    markStatus(states, id, 'unconfirmed');
  }
}
function activeTurns(thread) {
  return (thread.turns || []).filter((turn) => turn.status === 'inProgress');
}
function adoptLiveTurn(turn, thread) {
  if (turn.id) return;
  if (nativeState(thread) !== 'active') return;
  const active = activeTurns(thread);
  if (active.length === 1) turn.id = active[0].id;
}
function nativeState(thread) {
  return thread.status?.type === 'active' ? 'active' : 'unconfirmed';
}
function markStatus(states, id, state) {
  states.set(id, { ...stateFor(states, id), state, checkedAt: new Date().toISOString() });
}
function idle(thread) {
  return thread.status?.type === 'idle';
}
function savedTurn(thread, id) {
  return (thread.turns || []).find((item) => item.id === id);
}
function currentRead(connection, states, id, turn, serial) {
  return connection.turns.get(id) === turn && stateFor(states, id).activitySerial === serial;
}
function applyStatus(connection, states, id, turn, thread, serial) {
  markStatus(states, id, nativeState(thread));
  if (!currentRead(connection, states, id, turn, serial)) return;
  if (!idle(thread)) return;
  const saved = savedTurn(thread, turn.id);
  if (saved) recoverTerminal(connection, id, saved);
}
function recoverTerminal(connection, id, turn) {
  if (!['completed', 'interrupted', 'failed'].includes(turn.status)) return;
  if (hasRequest(connection, id)) return;
  captureMessages(connection, id, turn.items);
  connection.event({
    method: 'turn/completed',
    params: { threadId: id, turn: { id: turn.id, status: turn.status }, recovered: true },
  });
}
function captureMessages(connection, id, items) {
  for (const item of (items || []).filter((item) => item.type === 'agentMessage'))
    connection.event({ method: 'item/completed', params: { threadId: id, item } });
}
