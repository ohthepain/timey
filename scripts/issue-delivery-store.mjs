import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, readJson, requireThat, writeJson } from './factory-ui/common.mjs';

export function evidence(entry) {
  requireThat(entry?.path && /^[a-f0-9]{64}$/.test(entry.sha256), 'Name evidence with its SHA-256.');
  requireThat(digest(readFileSync(entry.path)) === entry.sha256, `Evidence changed: ${entry.path}`);
  return entry;
}
export function proof(path) {
  return { path, sha256: digest(readFileSync(path)) };
}
export class DeliveryStore {
  constructor(root, issueId) {
    requireThat(/^[a-zA-Z0-9_-]+$/.test(issueId), 'Use the full issue ID.');
    this.root = realpathSync(root);
    this.directory = join(realpathSync(root), '.issues/issue-deliveries', issueId);
    this.path = join(this.directory, 'current.json');
  }
  read() {
    return existsSync(this.path) ? readJson(this.path) : null;
  }
  save(value) {
    mkdirSync(this.directory, { recursive: true });
    writeJson(this.path, value);
    return value;
  }
  async locked(task) {
    mkdirSync(this.directory, { recursive: true });
    const lock = join(this.directory, 'operation.lock');
    mkdirSync(lock);
    writeJson(join(lock, 'owner.json'), { pid: process.pid, at: new Date().toISOString() });
    try {
      const result = await task();
      rmSync(lock, { recursive: true });
      return result;
    } catch (error) {
      writeJson(join(lock, 'failure.json'), { error: error.message });
      if (!error.preserveLock) rmSync(lock, { recursive: true });
      throw error;
    }
  }
  async targetLocked(task) {
    const lock = join(this.root, '.issues/issue-delivery-target.lock');
    mkdirSync(lock);
    writeJson(join(lock, 'owner.json'), { pid: process.pid, delivery: this.path });
    try {
      return await task();
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
  retain(name, value) {
    const path = join(this.directory, name + '.json');
    const bytes = JSON.stringify(value, null, 2) + '\n';
    if (existsSync(path))
      requireThat(readFileSync(path, 'utf8') === bytes, 'Immutable delivery record changed: ' + path);
    else writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    return proof(path);
  }
  async effect(kind, inputs, discover, apply) {
    const key = digest(JSON.stringify({ kind, inputs }));
    const intent = join(this.directory, key + '-intent.json');
    const result = join(this.directory, key + '-result.json');
    if (existsSync(result)) return readJson(result).value;
    const recovering = existsSync(intent);
    this.retain(key + '-intent', { kind, inputs });
    const found = await discover();
    requireThat(found.length <= 1, 'Ambiguous remote outcome; reconcile before retrying ' + kind + '.');
    requireThat(
      found.length || !recovering,
      'Uncertain ' + kind + ' outcome; discover the original effect before retrying.'
    );
    const value = found[0] || (await apply());
    this.retain(key + '-result', { value });
    return value;
  }
}
