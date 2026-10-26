import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decisionView, listIssues } from './factory-interface.mjs';
import { factory } from './factory-ledger.mjs';
import { statusOutput } from './factory-status.mjs';
export { factory };

function runCommand(project, argv) {
  const [command, ...args] = argv;
  // The listing path bypasses the coordinator parser and registry entirely.
  if (command === 'issues') return listIssues(project, args);
  if (['human', 'launch', 'both', 'integrate'].includes(command))
    throw Error(`Use $factory ${argv.join(' ')} in chat; this operation needs the coordinator and app tools.`);
  const api = factory(project);
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const ledger = join(project, '.issues/factory.json');
  const commands = new Map([
    ['init', () => api.init()],
    ['recover', () => api.recover(json(args[0]))],
    ['inspect', () => api.inspect()],
    ['status', () => statusOutput(project, existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : null, args)],
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
    const result = runCommand(process.cwd(), process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
