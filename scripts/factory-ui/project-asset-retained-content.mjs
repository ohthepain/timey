import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from './common.mjs';

const recordId = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,159}$/;
const sha256 = /^[a-f0-9]{64}$/;
const maxFile = 8 * 1024 * 1024;
const matchesPattern = (value, pattern) => typeof value === 'string' && pattern.test(value);

async function retainedBytes(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > maxFile || (await realpath(path)) !== path) {
    throw Error('Retained content must be a regular project file within the size limit.');
  }
  return readFile(path);
}

function matchedReference(bytes, label) {
  return { sha256: digest(bytes), bytes: bytes.length, label };
}

async function publicationEvidence(directory, item, index) {
  if (item.status !== 'verified' || !matchesPattern(item.sha256, sha256))
    throw Error('Published evidence is unverified.');
  const bytes = await retainedBytes(join(directory, 'evidence-' + index + '-' + item.sha256.slice(0, 16)));
  const result = matchedReference(bytes, 'Published investigation evidence');
  if (result.sha256 !== item.sha256) throw Error('Published evidence bytes have changed.');
  return result;
}

async function publishedReport(report, directory) {
  const document = matchedReference(Buffer.from(report.content), 'Published investigation report');
  const matches = await Promise.allSettled([
    document.sha256 === report.contentSha256 ? document : Promise.reject(Error('Published report bytes have changed.')),
  ]);
  for (const [index, item] of report.evidence.entries()) {
    matches.push(...(await Promise.allSettled([publicationEvidence(directory, item, index)])));
  }
  return matches;
}

async function discussionAttachment(directory, attachment) {
  if (!matchesPattern(attachment.id, recordId)) throw Error('Invalid retained attachment identity.');
  const bytes = await retainedBytes(join(directory, 'attachments', attachment.id + '.bin'));
  if (bytes.length !== attachment.size) throw Error('Retained attachment bytes have changed.');
  return matchedReference(bytes, 'Restricted reference');
}

async function discussionMessage(directory, message) {
  const attachments = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  return Promise.allSettled([...attachments.values()].map((item) => discussionAttachment(directory, item)));
}

async function discussion(session, directory) {
  const messages = [...session.messages, ...(session.queue ?? []), ...(session.draft ? [session.draft] : [])];
  const matches = [];
  for (const message of messages) matches.push(...(await discussionMessage(directory, message)));
  return matches;
}

async function readRetainedDirectory(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    if ((await realpath(path)) !== path) throw Error('Retained content must be inside the project.');
    return entries;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function collectRetained(directory, filename, collect) {
  const entries = await readRetainedDirectory(directory);
  const matches = [];
  for (const entry of entries.filter((entry) => recordId.test(entry.name))) {
    const folder = join(directory, entry.name);
    try {
      if (!entry.isDirectory()) throw Error('A retained content record must be a project directory.');
      const record = JSON.parse(await retainedBytes(join(folder, filename)));
      matches.push(...(await collect(record, folder)));
    } catch (reason) {
      matches.push({ status: 'rejected', reason });
    }
  }
  return matches;
}

export async function retainedContentReferences(root) {
  const directory = join(await realpath(root), '.issues/factory-ui');
  const results = await Promise.allSettled([
    collectRetained(join(directory, 'investigation-reports'), 'report.json', publishedReport),
    collectRetained(join(directory, 'project-discuss'), 'conversation.json', discussion),
  ]);
  const matches = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [result]));
  return {
    refs: matches.flatMap((match) => (match.status === 'fulfilled' ? [match.value] : [])),
    unavailable: matches.some((match) => match.status === 'rejected'),
  };
}
