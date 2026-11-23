import { lstatSync, readFileSync } from 'node:fs';

export function fileGeneration(path) {
  const value = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!value?.isFile()) return null;
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
}

export class FileReadCache {
  constructor(parse, maximumBytes = 32 * 1024 * 1024) {
    this.parse = parse;
    this.maximumBytes = maximumBytes;
    this.entries = new Map();
    this.bytes = 0;
  }
  forget(path) {
    const previous = this.entries.get(path);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(path);
  }
  retain(paths) {
    const selected = new Set(paths);
    for (const path of this.entries.keys()) if (!selected.has(path)) this.forget(path);
  }
  read(path) {
    const generation = fileGeneration(path);
    const previous = this.entries.get(path);
    if (generation && previous?.generation === generation) {
      this.entries.delete(path);
      this.entries.set(path, previous);
      return structuredClone(previous.value);
    }
    this.forget(path);
    const content = readFileSync(path, 'utf8');
    const value = this.parse(content, path);
    const bytes = Buffer.byteLength(content);
    if (generation && fileGeneration(path) === generation && bytes <= this.maximumBytes) {
      this.entries.set(path, { generation, value, bytes });
      this.bytes += bytes;
      while (this.bytes > this.maximumBytes || this.entries.size > 256) this.forget(this.entries.keys().next().value);
    }
    return structuredClone(value);
  }
}
