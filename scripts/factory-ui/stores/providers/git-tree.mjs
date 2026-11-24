import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertStore } from './records.mjs';

async function valueFiles(directory, changes, prefix) {
  const files = [];
  for (const [index, [path, value]] of changes.entries()) {
    assertStore(path.startsWith(prefix) && !path.includes('/../'), 'Only dedicated store metadata can be changed.');
    if (value === null) continue;
    const file = join(directory, 'value-' + index);
    await writeFile(file, JSON.stringify(value));
    files.push(file);
  }
  return files;
}
async function writeBlobs(files, plumbing) {
  if (!files.length) return [];
  const input = files.map((file) => JSON.stringify(file)).join('\n') + '\n';
  return (await plumbing(['hash-object', '-w', '--stdin-paths'], input)).trim().split('\n');
}
function indexEntries(changes, blobs) {
  const zero = '0'.repeat(blobs[0]?.length ?? 40);
  let index = 0;
  return changes
    .map(([path, value]) => (value === null ? '0 ' + zero : '100644 ' + blobs[index++]) + '\t' + path + '\0')
    .join('');
}
export async function writeGitTree({ head, changes, prefix, git, plumbing }) {
  const directory = await mkdtemp(join(tmpdir(), 'timey-record-index-'));
  const env = { GIT_INDEX_FILE: join(directory, 'index') };
  try {
    await git(head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
    const blobs = await writeBlobs(await valueFiles(directory, changes, prefix), plumbing);
    await plumbing(['update-index', '-z', '--index-info'], indexEntries(changes, blobs), env);
    const tree = (await git(['write-tree'], { env })).trim();
    const date = new Date().toISOString();
    return (
      await git(
        [
          '-c',
          'user.name=Timey Factory',
          '-c',
          'user.email=factory@timey.invalid',
          'commit-tree',
          tree,
          ...(head ? ['-p', head] : []),
          '-m',
          'Update Factory store records',
        ],
        { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }
      )
    ).trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function gitCommitIdentity(git, head, commit) {
  const baseTree = (await git(['rev-parse', head + '^{tree}'])).trim();
  const format = '%T%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B';
  const [tree, authorName, authorEmail, authorDate, name, email, date, message] = (
    await git(['show', '-s', '--format=' + format, commit])
  ).split('\0');
  return {
    oid: commit,
    baseTree,
    tree,
    message: message.slice(0, -1),
    author: { name: authorName, email: authorEmail, date: authorDate },
    committer: { name, email, date },
  };
}
