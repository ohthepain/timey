import { IssueDelivery } from './issue-delivery.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decisionView, listIssues } from './factory-interface.mjs';
import { factory, readFactoryRegistry } from './factory-ledger.mjs';
import { statusOutput } from './factory-status.mjs';
import { readRuntime } from './factory-ui/runtime.mjs';
export { factory };

export async function runCommand(project, argv, delivery = new IssueDelivery(project)) {
  const [command, ...args] = argv;
  if (command === 'issue-delivery') {
    const [kind, issueId, path] = args;
    if (kind === 'inspect') return delivery.inspect(issueId);
    return delivery.operate(kind, { ...(path ? JSON.parse(readFileSync(path, 'utf8')) : {}), issueId });
  }
  // The listing path bypasses the coordinator parser and registry entirely.
  const reads = new Map([
    ['issues', () => listIssues(project, args)],
    ['runtime', () => readRuntime(args[0])],
  ]);
  if (reads.has(command)) return reads.get(command)();
  if (['human', 'launch', 'both', 'integrate'].includes(command))
    throw Error(`Use $factory ${argv.join(' ')} in chat; this operation needs the coordinator and app tools.`);
  const api = factory(project);
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const commands = new Map([
    ['init', () => api.init()],
    [
      'finalize-delivery',
      () =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [fileURLToPath(new URL('./factory-delivery.mjs', import.meta.url)), project, args[0]],
            { encoding: 'utf8' }
          )
        ),
    ],
    ['recover', () => api.recover(json(args[0]))],
    ['inspect', () => api.inspect()],
    ['status', () => statusOutput(project, readFactoryRegistry(project), args)],
    ['recommend', () => api.recommend(json(args[0]))],
    ['reserve', () => api.reserve(args[0])],
    ['attach', () => api.attach(args[0], json(args[1]))],
    ['record', () => api.record(args[0], json(args[1]))],
    ['complete', () => recordIssueWork(project, command, args[0])],
    ['record-checks', () => recordIssueWork(project, command, args[0])],
  ]);
  return commands.has(command) ? commands.get(command)() : decisionView(api.inspect(), argv);
}
function recordIssueWork(project, operation, path) {
  const helper = fileURLToPath(new URL('./factory-record.mjs', import.meta.url));
  return JSON.parse(
    execFileSync(process.execPath, [helper, operation, project, path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCommand(process.cwd(), process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
