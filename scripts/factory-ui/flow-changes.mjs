import { readFileSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { systemFlowDirectory } from './ui-source.mjs';

const transient = /(?:^|\/)(?:node_modules|\.git)(?:\/|$)|\.(?:tmp|lock)$/;
const gitState = /^(?:HEAD|index|packed-refs|config|MERGE_HEAD|refs)(?:\/|$)/;

function gitDirectory(checkout) {
  const marker = join(checkout, '.git');
  try {
    if (statSync(marker).isDirectory()) return marker;
    const match = /^gitdir: (.+)/.exec(readFileSync(marker, 'utf8').trim());
    if (match) return resolve(checkout, match[1]);
  } catch {
    // The checkout might not have been created yet.
  }
  return null;
}

function commonGitDirectory(git) {
  try {
    return resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim());
  } catch {
    return git;
  }
}

export function createFlowChanges(root, onSourceFileChange) {
  const streams = new Map();
  const watchers = new Map();
  const pending = new Set();
  let batch;

  function notify(topic = 'flow', issue) {
    for (const [response, selection] of streams) {
      if (issue && selection.issue && selection.issue !== issue) continue;
      pending.add(response);
      selection.sources ||= topic === 'sources';
    }
    if (!pending.size || batch) return;
    batch = setTimeout(flush, 150).unref();
  }

  function flush() {
    batch = null;
    sync();
    for (const response of pending) {
      const selection = streams.get(response);
      if (!selection) continue;
      if (selection.sources) response.write('event: sources\ndata: changed\n\n');
      selection.sources = false;
      if (!response.write('event: flow\ndata: changed\n\n')) response.destroy();
    }
    pending.clear();
  }

  function sync() {
    const wanted = new Map();
    function add(path, recursive, changed) {
      if (!wanted.has(path)) wanted.set(path, { recursive, handlers: [] });
      wanted.get(path).handlers.push(changed);
    }
    function git(checkout, issue) {
      const directory = gitDirectory(checkout);
      if (!directory) return;
      const changed = (name) => {
        if (!name || gitState.test(name)) notify('flow', issue);
      };
      for (const path of new Set([directory, commonGitDirectory(directory)])) {
        add(path, false, changed);
        add(join(path, 'refs'), true, () => notify('flow', issue));
      }
    }
    if (streams.size) {
      const issues = join(root, '.issues');
      add(root, false, (name) => {
        if (!name || name === '.issues' || name === 'user') notify('sources');
      });
      add(issues, false, (name) => {
        if (!name || (!transient.test(name) && /^(?:[^/]+\.(?:md|json)|[^.]+)$/.test(name))) notify();
      });
      for (const name of ['closed', 'archive']) {
        add(join(issues, name), true, (file) => {
          if (!file || !transient.test(file)) notify();
        });
      }
      for (const directory of ['flows', 'conversations']) {
        add(join(issues, directory), true, (name) => {
          if (!name || !transient.test(name)) notify('flow', name?.split('/')[0]);
        });
      }
      add(join(issues, 'factory-progress'), false, (name) => {
        if (!name || name.endsWith('.json')) notify('flow', name?.slice(0, -5));
      });
      add(join(issues, 'factory-ui'), false, (name) => {
        if (!name || /^(lifecycle|runs)\.json$/.test(name)) notify();
      });
      add(join(issues, 'store-runtime'), false, (name) => {
        if (name === 'pending-flows') notify();
      });
      add(join(issues, 'store-runtime/pending-flows'), false, (name) => {
        if (!name || name.endsWith('.json')) notify('flow', name?.slice(0, -5));
      });
      add(join(root, 'user'), true, (name) => {
        if (name && transient.test(name)) return;
        onSourceFileChange?.(name);
        notify('sources');
      });
      add(systemFlowDirectory(), true, (name) => {
        if (!name || !transient.test(name)) notify('sources');
      });
      git(root);
      for (const { issue, checkout } of streams.values()) {
        if (!checkout || checkout === root) continue;
        add(checkout, true, (name) => {
          if (
            !name ||
            (!transient.test(name) && (!name.startsWith('.issues/') || name.startsWith('.issues/conversations/')))
          )
            notify('flow', issue);
        });
        git(checkout, issue);
      }
    }
    for (const [path, entry] of watchers) {
      if (wanted.has(path) && directoryIdentity(path) === entry.identity) continue;
      entry.watcher.close();
      watchers.delete(path);
    }
    for (const [path, { recursive, handlers }] of wanted) {
      const existing = watchers.get(path);
      if (existing) {
        existing.handlers = handlers;
        continue;
      }
      const identity = directoryIdentity(path);
      if (!identity) continue;
      try {
        const watcher = watch(path, { recursive, persistent: false }, (_event, file) => {
          if (file && /\.(?:tmp|lock)$/.test(file)) return;
          for (const handler of watchers.get(path)?.handlers || []) handler(file);
        });
        watcher.on('error', () => {
          watcher.close();
          if (watchers.get(path)?.watcher === watcher) watchers.delete(path);
        });
        watchers.set(path, { watcher, handlers, identity });
      } catch {
        // A directory can disappear between stat and watch. The next sync retries.
      }
    }
  }

  function subscribe(response, issue) {
    streams.set(response, { issue });
    response.once('close', () => {
      streams.delete(response);
      pending.delete(response);
      sync();
    });
    sync();
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 3000\n\n: connected\n\n');
  }

  function checkout(issue, path) {
    let changed = false;
    for (const selection of streams.values()) {
      if (selection.issue !== issue || selection.checkout === path) continue;
      selection.checkout = path;
      changed = true;
    }
    if (changed) {
      sync();
      // The snapshot used to discover this checkout may predate the watcher.
      notify('flow', issue);
    }
  }

  const heartbeat = setInterval(() => {
    sync();
    for (const response of streams.keys()) {
      if (!response.write(': heartbeat\n\n')) response.destroy();
    }
  }, 20_000).unref();
  return {
    subscribe,
    notify,
    checkout,
    close: () => {
      clearInterval(heartbeat);
      clearTimeout(batch);
      for (const { watcher } of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

function directoryIdentity(path) {
  const info = statSync(path, { throwIfNoEntry: false });
  if (info?.isDirectory()) return info.dev + ':' + info.ino;
}
