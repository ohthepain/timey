import { existsSync, readdirSync, realpathSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { digest, requireThat, writeJson } from './common.mjs';

export function captureInstructions(root, directory) {
  const inputs = instructionPaths(root).flatMap((path) => captureFile(path, directory));
  if (inputs.length) writeJson(join(directory, 'instruction-inputs.json'), inputs);
  return inputs;
}
function instructionPaths(root) {
  const guides = markdownFiles(join(root, 'docs/agents'));
  const skills = join(root, '.agents/skills');
  const installed = existsSync(skills) ? readdirSync(skills).flatMap((name) => skillFiles(join(skills, name))) : [];
  return [join(root, 'AGENTS.md'), ...guides, ...installed].filter(existsSync);
}
function skillFiles(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [];
  const canonical = realpathSync(path);
  return [join(path, 'SKILL.md'), ...markdownFiles(join(path, 'references'))]
    .filter(existsSync)
    .filter((file) => contained(canonical, realpathSync(file)));
}
function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => markdownEntry(directory, entry));
}
function markdownEntry(directory, entry) {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return markdownFiles(path);
  return entry.name.endsWith('.md') ? [path] : [];
}
function captureFile(path, directory) {
  try {
    return captureReadableFile(path, directory);
  } catch (error) {
    return [{ requested: path, error: `Cannot read ${path}: ${error.message}` }];
  }
}
function captureReadableFile(path, directory) {
  const canonical = realpathSync(path),
    stat = statSync(canonical);
  if (!stat.isFile() || stat.size >= 1048576) return [];
  const content = readFileSync(canonical),
    sha256 = digest(content);
  const folder = join(directory, 'instructions'),
    snapshot = join(folder, digest(path) + '.md');
  mkdirSync(folder, { recursive: true });
  writeFileSync(snapshot, content, { mode: 0o600 });
  return [{ requested: path, canonical, sha256, snapshot }];
}
export function instructionEvidence(path, inputs) {
  const canonical = realpathSync(path);
  const input = inputs.find((entry) => entry.canonical === canonical || entry.requested === path);
  if (!input) return null;
  validateInstruction(input);
  return {
    path: input.snapshot,
    sha256: input.sha256,
    kind: 'instruction',
    source: input.requested,
    resolved: input.canonical,
  };
}
export function validateInstructions(inputs) {
  for (const input of inputs.filter((entry) => entry.snapshot)) validateInstruction(input);
}
function validateInstruction(input) {
  requireThat(!input.error, input.error);
  requireThat(
    realpathSync(input.requested) === input.canonical,
    `The installed instruction link changed: ${input.requested}. Refresh this review.`
  );
  requireThat(
    digest(readFileSync(input.canonical)) === input.sha256,
    `The instructions changed during review: ${input.requested}. Refresh this review.`
  );
  requireThat(
    digest(readFileSync(input.snapshot)) === input.sha256,
    `The saved instruction copy changed: ${input.snapshot}. Refresh this review.`
  );
}
function contained(root, file) {
  const child = relative(root, file);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

export function approvedEvidence(path, permissions) {
  const canonical = realpathSync(path),
    permission = permissions.find((p) => p.path === canonical);
  if (!permission) return null;
  requireThat(
    digest(readFileSync(canonical)) === permission.sha256,
    `The approved file changed: ${path}. Refresh its review.`
  );
  requireThat(
    digest(readFileSync(permission.snapshot)) === permission.sha256,
    `The saved copy changed: ${permission.snapshot}. Refresh its review.`
  );
  return { path: permission.snapshot, sha256: permission.sha256, source: canonical, kind: 'supporting-file' };
}
