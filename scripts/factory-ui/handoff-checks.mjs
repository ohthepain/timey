import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidence, proof } from '../issue-delivery-store.mjs';
import { git, readJson, requireThat, writeJson } from './common.mjs';

// Failure is evidence at handoff, never a passing verification result. Identity
// and clean-source errors still block publication of an unknown candidate.
export async function checkHandoff(check, root, base, folder) {
  const head = git(root, 'rev-parse', 'HEAD'),
    tree = git(root, 'rev-parse', 'HEAD^{tree}');
  requireThat(!git(root, 'status', '--porcelain'), 'Preserve source changes before the draft PR handoff.');
  git(root, 'merge-base', '--is-ancestor', base, head);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'handoff-check.json');
  if (existsSync(path)) {
    const saved = readJson(path);
    requireThat(saved.head === head && saved.tree === tree && saved.base === base, 'The handoff candidate changed.');
    saved.evidence.forEach(evidence);
    return { ...saved, evidence: [...saved.evidence, proof(path)] };
  }
  let checked,
    failure = null;
  try {
    checked = await check(root, base, folder);
  } catch (error) {
    failure = error.message;
  }
  requireThat(
    git(root, 'rev-parse', 'HEAD') === head && !git(root, 'status', '--porcelain'),
    'Source changed during handoff checks.'
  );
  const files = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile())
    .map((file) => proof(join(file.parentPath, file.name)));
  const summaries = [...new Set([...(checked?.summaries || []), ...failedSummaries(files)])];
  const commands = [];
  for (const summary of summaries) {
    files.push(proof(summary));
    for (const command of readJson(summary).checks || []) {
      commands.push({ name: command.name, passed: command.passed, exit: command.exit });
      files.push(proof(command.log));
      for (const artifact of command.artifacts || []) files.push(proof(artifact.path));
    }
  }
  const result = { head, tree, base, summaries, commands, passed: !failure, failure, evidence: files };
  writeJson(path, result);
  return { ...result, evidence: [...files, proof(path)] };
}

function failedSummaries(files) {
  return files
    .filter((file) => file.path.endsWith('.log'))
    .flatMap((file) => {
      const output = readFileSync(file.path, 'utf8');
      return [...output.matchAll(/^Verification summary: (.+)$/gm)].map((match) => match[1].trim()).filter(existsSync);
    });
}
