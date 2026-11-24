import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function startup(hidden = false) {
  const source = readFileSync(new URL('./factory-ui/flow-ui.js', import.meta.url), 'utf8');
  const start = source.indexOf('  let changes;');
  assert.ok(start > 0, 'Exercise the real Flow startup and subscription code.');
  const loads = [];
  const streams = [];
  const timers = new Map();
  const listeners = new Map();
  const document = { hidden, addEventListener: (name, callback) => listeners.set(name, callback) };
  class EventSource {
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      streams.push(this);
    }
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }
    close() {
      this.closed = true;
    }
  }
  vm.runInNewContext('(() => {\n' + source.slice(start), {
    document,
    window: { addEventListener() {}, dispatchEvent() {} },
    EventSource,
    state: { issueId: null, pending: false, loading: false },
    load: (...args) => loads.push(args),
    setTimeout: (callback) => {
      const id = timers.size + 1;
      timers.set(id, callback);
      return id;
    },
    setInterval() {},
    updateBlockTimers() {},
    renderErrors() {},
    serverControlUI: { watchConnection() {} },
  });
  return { document, loads, streams, listeners, timers };
}

test('Flow loads its first issue snapshot without waiting for the live stream to open', () => {
  const f = startup();
  assert.equal(f.streams.length, 1);
  assert.equal(f.streams[0].url, '/api/flow-changes');
  assert.equal(f.loads.length, 1, 'The issue list must load even if EventSource never opens.');
  f.streams[0].listeners.get('flow')();
  for (const [id, callback] of f.timers) {
    f.timers.delete(id);
    callback();
  }
  assert.equal(f.loads.length, 2, 'Live changes must still refresh the issue list.');
});

test('Flow loads its first snapshot in a background tab and subscribes when visible', () => {
  const f = startup(true);
  assert.equal(f.streams.length, 0);
  assert.equal(f.loads.length, 1, 'Background visibility must not leave the initial list empty.');
  f.document.hidden = false;
  f.listeners.get('visibilitychange')();
  assert.equal(f.streams.length, 1);
});
