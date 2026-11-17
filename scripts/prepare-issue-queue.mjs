import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const registry = '.issues/issue-numbers.json';
const report = /^\.issues\/(?:closed\/)?(\d{8}T\d{6}(?:\d{3})?Z?-[a-f0-9]{4,32})\.md$/;
const sourceRef = process.argv[2];
if (!sourceRef) throw Error('Usage: node scripts/prepare-issue-queue.mjs <source-revision>');

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
}

const source = git(['rev-parse', '--verify', '--end-of-options', sourceRef + '^{commit}']).trim();
const entries = git(['ls-tree', '-rz', source, '--', '.issues/']).split('\0').filter(Boolean);
const numbers = JSON.parse(git(['show', source + ':' + registry]));
const ids = new Set();
const staged = [];
let closed = 0;
let moved = 0;
for (const entry of entries) {
  const [object, path] = entry.split('\t');
  const id = report.exec(path)?.[1];
  if (!id && path !== registry) continue;
  if (!object.startsWith('100644 blob ')) throw Error('Queue data must be a regular file: ' + path);
  if (!id) {
    staged.push(entry);
    continue;
  }
  if (ids.has(id) || !Number.isSafeInteger(numbers.issues?.[id]))
    throw Error('Duplicate report or missing issue number: ' + path);
  ids.add(id);
  const content = git(['cat-file', 'blob', object.split(' ')[2]]);
  const metadata = parse(content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '');
  if (typeof metadata?.state !== 'string' || typeof metadata.title !== 'string')
    throw Error('Review report metadata before migration: ' + path);
  const isClosed = metadata.state === 'closed';
  if (path.startsWith('.issues/closed/') && !isClosed) throw Error('Review the nonclosed report in Closed: ' + path);
  const destination = isClosed ? `.issues/closed/${id}.md` : path;
  if (isClosed) closed++;
  if (destination !== path) moved++;
  staged.push(object + '\t' + destination);
}

const assigned = Object.values(numbers.issues ?? {});
if (
  !ids.size ||
  !Number.isSafeInteger(numbers.next) ||
  assigned.some((number) => !Number.isSafeInteger(number) || number < 1 || number >= numbers.next) ||
  new Set(assigned).size !== assigned.length
)
  throw Error('Review the report inventory and issue number registry before migration.');

const temporary = mkdtempSync(join(tmpdir(), 'timey-queue-seed-'));
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
  git(['read-tree', '--empty'], { env });
  git(['update-index', '-z', '--index-info'], { env, input: staged.join('\0') + '\0' });
  const tree = git(['write-tree'], { env }).trim();
  const seed = git(['commit-tree', tree, '-m', 'Seed the shared issue queue from ' + source]).trim();
  console.log(JSON.stringify({ seed, source, reports: ids.size, closed, moved, reservedNumbers: assigned.length }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
