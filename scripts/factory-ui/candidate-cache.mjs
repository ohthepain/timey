import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest, readJson, writeJson, git } from './common.mjs';

export function candidateInput(root, base, runner) {
  const modules = join(root, 'node_modules/.modules.yaml');
  if (!existsSync(modules) || git(root, 'status', '--porcelain', '--untracked-files=all')) return null;
  return digest(
    JSON.stringify({
      base: git(root, 'rev-parse', base),
      tree: git(root, 'rev-parse', 'HEAD^{tree}'),
      runtime: process.version,
      executable: process.execPath,
      environment: digest(JSON.stringify(Object.entries(process.env).sort())),
      modules: digest(readFileSync(modules)),
      locks: ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml'].map((path) =>
        existsSync(join(root, path)) ? digest(readFileSync(join(root, path))) : null
      ),
      runner,
    })
  );
}
export function retainedCandidate(root, key, validate) {
  if (!key) return null;
  try {
    const saved = readJson(join(root, '.issues/candidate-checks', key + '.json'));
    for (const file of saved.evidence) if (digest(readFileSync(file.path)) !== file.sha256) return null;
    for (const path of saved.result.summaries) validate(readJson(path));
    return { ...saved.result, head: git(root, 'rev-parse', 'HEAD'), reused: true };
  } catch {
    return null;
  }
}
export function retainCandidate(root, key, result) {
  if (!key) return;
  const paths = result.summaries.flatMap((path) => [
    path,
    ...readJson(path).checks.flatMap((c) => [c.log, ...(c.artifacts || []).map((a) => a.path)]),
  ]);
  const evidence = [...new Set(paths)].map((path) => ({ path, sha256: digest(readFileSync(path)) }));
  const directory = join(root, '.issues/candidate-checks');
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, key + '.json'), { result, evidence });
}

// Failed attempts are diagnostic evidence, never passing candidate proof.
export function retainedFailure(root, key) {
  if (!key) return null;
  try {
    const saved = readJson(join(root, '.issues/candidate-checks', key + '-failed.json'));
    for (const file of saved.evidence) if (digest(readFileSync(file.path)) !== file.sha256) return null;
    return saved;
  } catch {
    return null;
  }
}
export function retainFailure(root, key, message, summaries, logs) {
  if (!key) return;
  const paths = [
    ...logs,
    ...summaries.flatMap((path) => [
      path,
      ...readJson(path).checks.flatMap((check) => [check.log, ...(check.artifacts || []).map((a) => a.path)]),
    ]),
  ];
  const evidence = [...new Set(paths)].map((path) => ({ path, sha256: digest(readFileSync(path)) }));
  mkdirSync(join(root, '.issues/candidate-checks'), { recursive: true });
  writeJson(join(root, '.issues/candidate-checks', key + '-failed.json'), { message, summaries, evidence });
}
