import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const context = new AsyncLocalStorage();
const retained = 120;
let database;
let flushTimer;
const pending = [];
const storeCounters = new Map();

export function countStoreRead(root, kind) {
  const project = basename(root);
  if (!storeCounters.has(project) && storeCounters.size >= 100) {
    storeCounters.delete(storeCounters.keys().next().value);
  }
  const counts = storeCounters.get(project) ?? {};
  counts[kind] = (counts[kind] ?? 0) + 1;
  storeCounters.set(project, counts);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!pending.length) return;
  const rows = pending.splice(0);
  const db = activityStore();
  const insert = db.prepare('INSERT INTO diagnostic_activity (category, details) VALUES (?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [category, details] of rows) insert.run(category, details);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function flushStoreActivity() {
  try {
    flush();
  } catch {
    // The local diagnostics store may be unavailable.
  }
}

function writeActivity(category, details) {
  if (category !== 'stores') {
    activityStore()
      .prepare(`
      INSERT INTO diagnostic_activity (category, details)
      SELECT ?, ? WHERE ? != 'codex' OR json_extract(?, '$.startedAt') >
        (SELECT reset_at FROM codex_activity_totals WHERE id = 1)
    `)
      .run(category, details, category, details);
    return;
  }
  pending.push([category, details]);
  if (pending.length >= retained) return flushStoreActivity();
  flushTimer ??= setTimeout(flushStoreActivity, 300).unref();
}

function activityStore() {
  if (database) return database;
  const directory = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'timey');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'diagnostics.sqlite'), { timeout: 500 });
  db.exec(`
    CREATE TABLE IF NOT EXISTS diagnostic_activity (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL,
      details TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_activity_totals (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total INTEGER NOT NULL,
      reset_at REAL NOT NULL
    );
    INSERT OR IGNORE INTO codex_activity_totals
      SELECT 1, COUNT(*), 0 FROM diagnostic_activity WHERE category = 'codex';
    CREATE TRIGGER IF NOT EXISTS count_codex_activity AFTER INSERT ON diagnostic_activity
      WHEN NEW.category = 'codex' BEGIN
        UPDATE codex_activity_totals SET total = total + 1 WHERE id = 1;
      END;
    CREATE INDEX IF NOT EXISTS diagnostic_category ON diagnostic_activity (category, id DESC);
    CREATE TRIGGER IF NOT EXISTS prune_diagnostic_activity AFTER INSERT ON diagnostic_activity BEGIN
      DELETE FROM diagnostic_activity WHERE category = NEW.category AND id <= (
        SELECT id FROM diagnostic_activity WHERE category = NEW.category ORDER BY id DESC LIMIT 1 OFFSET ${retained}
      );
    END;
  `);
  database = db;
  return db;
}

export function withDiagnosticContext(root, details, operation) {
  return context.run({ project: basename(root), ...details }, operation);
}

export function diagnosticContext(root) {
  return context.getStore() ?? (root ? { project: basename(root) } : {});
}

export function recordActivity(category, details) {
  try {
    writeActivity(category, JSON.stringify(details));
  } catch {
    // Diagnostics must not change the result of the work they observe.
  }
}

export function beginActivity(category, operation, details = {}) {
  const startedAt = Date.now();
  const start = performance.now();
  const scope = diagnosticContext();
  return (status, extra) =>
    recordActivity(category, {
      ...scope,
      ...details,
      ...extra,
      operation,
      startedAt,
      durationMs: performance.now() - start,
      status,
    });
}

export function observeActivity(category, operation, details, work) {
  const record = beginActivity(category, operation, details);
  return Promise.resolve()
    .then(work)
    .then(
      (result) => {
        record('Completed');
        return result;
      },
      (error) => {
        record('Failed');
        throw error;
      }
    );
}

export function readDiagnosticActivity() {
  try {
    flush();
    return {
      retained,
      codexTotal: activityStore().prepare('SELECT total FROM codex_activity_totals WHERE id = 1').get().total,
      stores: Object.fromEntries(storeCounters),
      rows: activityStore()
        .prepare('SELECT id, category, details FROM diagnostic_activity ORDER BY id DESC')
        .all()
        .map(({ id, category, details }) => ({ id, category, ...JSON.parse(details) })),
    };
  } catch {
    return { unavailable: true, rows: [] };
  }
}

export function resetCodexActivity() {
  const db = activityStore();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE codex_activity_totals SET total = 0, reset_at = ? WHERE id = 1').run(Date.now());
    db.exec("DELETE FROM diagnostic_activity WHERE category = 'codex'");
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return readDiagnosticActivity();
}
