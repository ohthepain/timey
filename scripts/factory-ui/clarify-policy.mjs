import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function combinedClarify(root) {
  const path = join(root, 'factory.config.json');
  return existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).clarification === 'combined';
}
// Keep the shared queue's saved identifiers and history intact. The factory
// executes one stage; the former investigation state is a compatibility alias.
export function clarificationLifecycle(root, stages) {
  if (!combinedClarify(root)) return { stages, aliases: {} };
  const clarify = stages.find((s) => s.role === 'ready-for-grilling');
  const investigate = stages.find((s) => s.role === 'ready-for-repro');
  if (!clarify || !investigate) return { stages, aliases: {} };
  return {
    aliases: { [investigate.state]: clarify.state },
    stages: stages
      .filter((s) => s !== investigate)
      .map((stage) => ({
        ...stage,
        ...(stage === clarify ? { combinedClarify: true } : {}),
        next: stage.next === investigate.state ? investigate.next : stage.next,
      })),
  };
}
export function clarificationState(queue, state) {
  return queue.lifecycleAliases?.[state] || state;
}
