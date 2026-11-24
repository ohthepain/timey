import { storeError } from './records.mjs';

async function unchanged(expected, actual) {
  const [before, after] = await Promise.all([expected, actual]);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw storeError('STORE_CONFLICT', 'Shared metadata used by this operation changed. Refresh before retrying.');
}
export function createGitReadSet(io, head) {
  const paths = new Map();
  const prefixes = new Map();
  let records;
  const all = () => (records ||= io.listAt(head, ''));
  return {
    all,
    get(path) {
      if (!paths.has(path)) paths.set(path, io.readPath(head, path));
      return paths.get(path);
    },
    list(prefix) {
      prefixes.set(
        prefix,
        all().then((records) => records.filter((record) => record.key.startsWith(prefix)))
      );
    },
    async check(next) {
      await Promise.all([...paths].map(([path, expected]) => unchanged(expected, io.readPath(next, path))));
      await Promise.all([...prefixes].map(([prefix, expected]) => unchanged(expected, io.listAt(next, prefix))));
    },
  };
}
