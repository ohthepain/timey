import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STATUS_CODES } from 'node:http';

const stateDirectory = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
const empty = { total: 0, failed: 0, calls: [] };
let database;

function history() {
  if (database) return database;
  const directory = join(stateDirectory, 'timey');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'github-calls.sqlite'), { timeout: 500 });
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_totals (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      reset_at REAL NOT NULL
    );
    INSERT OR IGNORE INTO github_totals VALUES (1, 0, 0, 0);
    CREATE TABLE IF NOT EXISTS github_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      repository TEXT,
      startedAt REAL NOT NULL,
      durationMs REAL,
      result TEXT NOT NULL,
      error TEXT,
      pid INTEGER
    );
    CREATE TRIGGER IF NOT EXISTS github_call_started AFTER INSERT ON github_calls BEGIN
      UPDATE github_totals SET total = total + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS github_call_finished AFTER UPDATE OF pid ON github_calls BEGIN
      UPDATE github_totals SET failed = failed + (NEW.error IS NOT NULL);
      DELETE FROM github_calls WHERE pid IS NULL AND id NOT IN (
        SELECT id FROM github_calls ORDER BY startedAt DESC, id DESC LIMIT 30
      );
    END;
  `);
  database = db;
  return db;
}

export function startGitHubCall({ operation, repository = null, startedAt = Date.now() }) {
  try {
    const { lastInsertRowid, changes } = history()
      .prepare(`
        INSERT INTO github_calls (operation, repository, startedAt, result, pid)
        SELECT ?, ?, ?, 'In progress', ? FROM github_totals WHERE reset_at <= ?
      `)
      .run(operation, repository, startedAt, process.pid, startedAt);
    if (changes) return lastInsertRowid;
  } catch {
    // A telemetry write must never stop the GitHub request.
  }
}

function finish(id, durationMs, result, error = null) {
  history()
    .prepare(
      'UPDATE github_calls SET pid = NULL, durationMs = ?, result = ?, error = ? WHERE id = ? AND pid IS NOT NULL'
    )
    .run(durationMs, result, error, id);
}

const failureDetails = new Map([
  ['Timed out', 'The GitHub request timed out.'],
  ['DNS lookup failed', 'Timey could not resolve the GitHub API address.'],
]);

function outcome(status, failure) {
  const http = statusLabel(status);
  if (failure) return { result: failure, error: transportExplanation(failure, http) };
  if (!http) return { result: 'Network error', error: 'No HTTP response was received.' };
  return { result: http, error: status >= 400 ? `GitHub returned HTTP ${http}.` : null };
}

function statusLabel(status) {
  if (!status) return null;
  return [status, STATUS_CODES[status]].filter(Boolean).join(' ');
}

function transportExplanation(failure, http) {
  if (http) return `The connection failed after GitHub returned HTTP ${http}.`;
  return failureDetails.get(failure) ?? 'No HTTP response was received.';
}

export function finishGitHubCall(id, { durationMs, status, failure }) {
  if (!id) return;
  const { result, error } = outcome(status, failure);
  try {
    finish(id, durationMs, result, error);
  } catch {
    // The caller still receives its original result.
  }
}

function processExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function reapInterrupted(db) {
  for (const { id, pid } of db.prepare('SELECT id, pid FROM github_calls WHERE pid IS NOT NULL').all()) {
    if (processExited(pid)) finish(id, null, 'Interrupted', 'Timey exited while the request was in progress.');
  }
}

function snapshot(db) {
  const { counts, calls } = db
    .prepare(`
    SELECT json_object('total', total, 'failed', failed) AS counts,
      (SELECT json_group_array(json_object(
        'id', id, 'operation', operation, 'repository', repository, 'startedAt', startedAt,
        'durationMs', durationMs, 'result', result, 'error', error
      )) FROM (SELECT * FROM github_calls ORDER BY startedAt DESC, id DESC LIMIT 30)) AS calls
    FROM github_totals
  `)
    .get();
  return { ...JSON.parse(counts), calls: JSON.parse(calls) };
}

export function readGitHubCalls() {
  try {
    const db = history();
    reapInterrupted(db);
    return snapshot(db);
  } catch {
    return { ...empty, unavailable: true };
  }
}

export function resetGitHubCalls() {
  const db = history();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE github_totals SET total = 0, failed = 0, reset_at = ?').run(Date.now());
    db.exec('DELETE FROM github_calls; COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return empty;
}
