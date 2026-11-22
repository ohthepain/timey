import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';

function snapshotObject(object) {
  return { object, descriptors: Object.getOwnPropertyDescriptors(object) };
}

function restoreObject({ object, descriptors }) {
  for (const key of Reflect.ownKeys(object)) {
    if (!Object.hasOwn(descriptors, key)) delete object[key];
  }
  Object.defineProperties(object, descriptors);
}

async function finishBackgroundTasks(service) {
  const seen = new Set();
  for (;;) {
    const flows = service.flows;
    const tasks = [
      ...[...flows.active.values()].map(({ task }) => task),
      ...flows.closureTasks.values(),
      ...[...flows.captures.values()].map(({ task }) => task),
      ...service.lifecycleTasks.values(),
      ...service.issueCleanupTasks.values(),
    ].filter((task) => task && !seen.has(task));
    if (tasks.length === 0) return;
    for (const task of tasks) seen.add(task);
    await Promise.allSettled(tasks);
  }
}

export async function withBrowserScenarioFixture({ project, service }, run) {
  const flows = service.flows;
  const executor = snapshotObject(flows.executor);
  const provider = flows.deliveryOptions.provider && snapshotObject(flows.deliveryOptions.provider);
  const files = [
    join(project, '.issues/triage-labels.md'),
    join(project, '.issues/preferences.json'),
    git(project, 'rev-parse', '--path-format=absolute', '--git-path', 'config'),
    git(project, 'rev-parse', '--path-format=absolute', '--git-path', 'config.worktree'),
  ].map((path) => ({ path, content: existsSync(path) ? readFileSync(path) : null }));
  let scenarioError;
  try {
    return await run();
  } catch (error) {
    scenarioError = error;
    throw error;
  } finally {
    try {
      try {
        await finishBackgroundTasks(service);
        if (flows.executor !== executor.object) await flows.executor.close();
      } finally {
        flows.executor = executor.object;
        restoreObject(executor);
        if (provider) {
          flows.deliveryOptions.provider = provider.object;
          restoreObject(provider);
        }
        for (const { path, content } of files) {
          if (content === null) rmSync(path, { force: true });
          else writeFileSync(path, content);
        }
      }
    } catch (error) {
      if (scenarioError) throw new AggregateError([scenarioError, error], 'Browser scenario and restoration failed.');
      throw error;
    }
  }
}
