import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { digest, requireThat, writeJson } from './common.mjs';

const identity = /^[\w-]{1,160}$/;
const maxReport = 2 * 1024 * 1024;
const maxEvidence = 8 * 1024 * 1024;
const fileReference = z.object({
  path: z.string().min(1).max(4000),
  sha256: z.string().optional(),
  name: z.string().optional(),
});
export const reportPublicationSchema = z.object({
  report: z.union([z.string().min(1).max(4000), fileReference]),
  title: z.string().trim().min(1).max(240),
  evidence: z
    .array(z.union([z.string(), fileReference]))
    .max(100)
    .optional(),
  additionalFindings: z.string().max(100000).default(''),
  inspectedRevisions: z
    .array(z.string().regex(/^[a-f0-9]{40}$/))
    .max(100)
    .optional(),
});

function checkedIdentity(value) {
  requireThat(typeof value === 'string' && identity.test(value), 'Choose a valid retained output identity.');
  return value;
}

export function checkedInvestigationSource(source) {
  requireThat(source && typeof source === 'object', 'Choose completed investigation findings.');
  for (const key of ['issueId', 'blockId', 'attemptId']) checkedIdentity(source[key]);
  requireThat(/^[a-f0-9]{40}$/.test(source.revision || ''), 'Retain the investigation source commit.');
  return structuredClone(source);
}

function containedFile(path, directories, maximum) {
  const actual = realpathSync(path);
  requireThat(
    directories.filter(existsSync).some((directory) => actual.startsWith(realpathSync(directory) + sep)),
    'Saved output files must belong to the issue checkout or this project.'
  );
  const info = statSync(actual);
  requireThat(info.isFile() && info.size <= maximum, 'Saved output must be a regular file within the size limit.');
  return readFileSync(actual);
}

function savedFile(reference, context, maximum) {
  const path = isAbsolute(reference.path) ? reference.path : resolve(context.workspace, reference.path);
  return { path, bytes: containedFile(path, context.directories, maximum) };
}

function evidenceState(item) {
  if (!item.path) return item;
  try {
    const bytes = readFileSync(item.path);
    if (digest(bytes) !== item.sha256)
      return { ...item, status: 'unverified', reason: 'The retained evidence differs from its recorded digest.' };
    return item;
  } catch {
    return { ...item, status: 'unavailable', reason: 'The retained evidence file is unavailable.' };
  }
}

function evidenceReference(item, index) {
  const original = typeof item === 'string' ? { path: item } : item;
  return { ...original, name: String(original.name ?? original.label ?? 'Evidence ' + (index + 1)).slice(0, 255) };
}

function evidenceVerification(expected, actual) {
  if (!expected || expected === actual) return { status: 'verified' };
  return { status: 'unverified', reason: 'The saved evidence differed from the supplied digest at publication.' };
}

function retainedEvidence(item, index, context) {
  const original = evidenceReference(item, index);
  try {
    const { bytes } = savedFile(original, context, maxEvidence);
    const sha256 = digest(bytes);
    const path = join(context.folder, 'evidence-' + index + '-' + sha256.slice(0, 16));
    writeFileSync(path, bytes, { mode: 0o600 });
    return {
      name: original.name,
      original: original.path,
      path,
      sha256,
      ...evidenceVerification(original.sha256, sha256),
    };
  } catch (error) {
    return { name: original.name, original: original.path, status: 'unavailable', reason: error.message };
  }
}

function publicationContent(input, context) {
  const reference = typeof input.report === 'string' ? { path: input.report } : input.report;
  const original = savedFile(reference, context, maxReport);
  requireThat(original.bytes.length > 0, 'Save a nonempty investigation report.');
  requireThat(
    !reference.sha256 || reference.sha256 === digest(original.bytes),
    'The saved report digest does not match.'
  );
  return {
    original: relative(context.workspace, original.path),
    content: original.bytes.toString('utf8'),
    contentSha256: digest(original.bytes),
  };
}

function evidenceIdentity(reference, workspace) {
  const path = typeof reference === 'string' ? reference : reference.path;
  return resolve(workspace, path);
}

function publicationEvidence(input, source, workspace) {
  const references = [...(input.evidence ?? []), ...(source.evidence ?? [])];
  const unique = [...new Map(references.map((item) => [evidenceIdentity(item, workspace), item])).values()];
  requireThat(unique.length <= 100, 'Retain up to 100 combined source and report evidence references.');
  return unique;
}

export class InvestigationReports {
  constructor(root) {
    this.root = realpathSync(root);
    this.directory = join(this.root, '.issues/factory-ui/investigation-reports');
  }
  file(id) {
    return join(this.directory, checkedIdentity(id), 'report.json');
  }
  list() {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && identity.test(entry.name) && existsSync(this.file(entry.name)))
      .map((entry) => this.read(entry.name))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  }
  read(id) {
    const path = this.file(id);
    requireThat(existsSync(path), 'This retained investigation report is unavailable.');
    requireThat(realpathSync(path) === path, 'Retained reports cannot be redirected outside their storage.');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    requireThat(saved.id === id && saved.version === 1, 'The retained report identity needs reconciliation.');
    return {
      ...saved,
      contentVerified: digest(saved.content) === saved.contentSha256,
      evidence: saved.evidence.map(evidenceState),
    };
  }
  deleteReports(ids) {
    requireThat(Array.isArray(ids) && ids.length > 0, 'Select reports to delete.');
    const paths = [...new Set(ids)].map((id) => {
      const file = this.file(id);
      this.read(id);
      return dirname(file);
    });
    for (const path of paths) rmSync(path, { recursive: true });
    return { deleted: paths.length };
  }
  publish(input) {
    const source = checkedInvestigationSource(input.source);
    const publicationId = checkedIdentity(input.publicationId);
    const id = digest(JSON.stringify([source.issueId, publicationId]));
    if (existsSync(this.file(id))) {
      const saved = this.read(id);
      requireThat(saved.source.attemptId === source.attemptId, 'This publication belongs to another inquiry.');
      return saved;
    }
    const parsed = reportPublicationSchema.parse(input);
    const context = this.publicationContext(id, input.workspace);
    const saved = {
      version: 1,
      id,
      publicationId,
      source,
      attemptId: checkedIdentity(input.attemptId),
      title: parsed.title,
      publishedAt: new Date().toISOString(),
      ...publicationContent(parsed, context),
      evidence: publicationEvidence(parsed, source, context.workspace).map((item, index) =>
        retainedEvidence(item, index, context)
      ),
      additionalFindings: parsed.additionalFindings,
      inspectedRevisions: [...new Set(parsed.inspectedRevisions ?? [source.revision])],
    };
    writeJson(this.file(id), saved);
    return this.read(id);
  }
  publicationContext(id, workspace = this.root) {
    const folder = join(this.directory, id);
    mkdirSync(folder, { recursive: true });
    requireThat(realpathSync(folder) === folder, 'Retained reports cannot be redirected outside their storage.');
    return {
      folder,
      workspace,
      directories: [...new Set([workspace, join(this.root, '.issues/factory-ui/flow-evidence')])],
    };
  }
}
