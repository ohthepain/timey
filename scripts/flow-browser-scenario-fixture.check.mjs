import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './factory-ui/common.mjs';
import { withBrowserScenarioFixture } from './flow-browser-scenario-fixture.mjs';

for (const configured of [false, true]) {
  for (const failing of [false, true]) {
    test(`restores ${configured ? 'existing' : 'absent'} scenario state after ${failing ? 'failure' : 'success'} and chained cleanup`, async (t) => {
      const evidence = join(process.cwd(), '.issues/evidence');
      mkdirSync(evidence, { recursive: true });
      const project = mkdtempSync(join(evidence, 'scenario-fixture-'));
      t.after(() => rmSync(project, { recursive: true, force: true }));
      mkdirSync(join(project, '.issues'));
      git(project, 'init', '-q');
      git(project, 'config', 'user.name', 'Scenario fixture');
      const paths = ['.issues/triage-labels.md', '.issues/preferences.json', '.git/config.worktree'];
      const expected = Buffer.from('Original configuration.\r\n');
      if (configured) {
        for (const path of paths) writeFileSync(join(project, path), expected);
        git(project, 'remote', 'add', 'origin', 'https://example.invalid/original');
        git(project, 'config', '--add', 'remote.origin.pushurl', 'https://example.invalid/first');
        git(project, 'config', '--add', 'remote.origin.pushurl', 'https://example.invalid/second');
      }
      const gitConfig = readFileSync(join(project, '.git/config'));
      const baselineRun = async () => 'baseline';
      const executor = {
        run: baselineRun,
        close() {
          assert.fail('Baseline executor must remain usable.');
        },
      };
      const baselineProvider = async () => 'original branches';
      const provider = { gh: baselineProvider };
      const service = {
        flows: {
          executor,
          deliveryOptions: { provider },
          active: new Map(),
          closureTasks: new Map(),
          captures: new Map(),
        },
        issueCleanupTasks: new Map(),
        lifecycleTasks: new Map(),
      };
      const events = [];
      const active = Promise.withResolvers();
      const cleanup = Promise.withResolvers();
      const failure = Error('Injected scenario failure');
      const scenario = withBrowserScenarioFixture({ service, project }, async () => {
        executor.run = async () => 'mutated';
        executor.extra = true;
        service.flows.executor = {
          run: async () => 'replacement',
          close() {
            events.push('closed');
          },
        };
        provider.gh = async () => 'synthetic branches';
        git(project, 'config', 'remote.origin.url', 'https://example.invalid/synthetic');
        for (const path of paths) writeFileSync(join(project, path), 'Contaminated');
        const task = active.promise.then(() => {
          events.push('execution finished');
          const closure = cleanup.promise.then(() => {
            assert.notEqual(service.flows.executor, executor, 'Cleanup retains its executor until finished.');
            writeFileSync(join(project, '.issues/triage-labels.md'), 'Late cleanup write');
            events.push('cleanup finished');
          });
          service.flows.closureTasks.set('issue', closure);
        });
        service.flows.active.set('issue', { task });
        if (failing) throw failure;
        return 'scenario result';
      });
      let finished = false;
      const observed = scenario.then(
        (result) => {
          finished = true;
          return result;
        },
        (error) => {
          finished = true;
          throw error;
        }
      );
      const assertion = failing ? assert.rejects(observed, (error) => error === failure) : observed;
      await new Promise((done) => setImmediate(done));
      assert.equal(finished, false, 'The next scenario cannot start while execution is active.');
      active.resolve();
      await new Promise((done) => setImmediate(done));
      assert.equal(finished, false, 'The boundary waits for cleanup spawned by execution.');
      cleanup.resolve();
      const result = await assertion;
      if (!failing) assert.equal(result, 'scenario result');
      await withBrowserScenarioFixture({ service, project }, async () => {
        assert.deepEqual(events, ['execution finished', 'cleanup finished', 'closed']);
        assert.equal(service.flows.executor, executor);
        assert.equal(executor.run, baselineRun);
        assert.equal('extra' in executor, false);
        assert.equal(provider.gh, baselineProvider);
        assert.deepEqual(readFileSync(join(project, '.git/config')), gitConfig);
        for (const path of paths) {
          assert.equal(existsSync(join(project, path)), configured);
          if (configured) assert.deepEqual(readFileSync(join(project, path)), expected);
        }
      });
    });
  }
}
