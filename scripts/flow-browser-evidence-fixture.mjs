import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './factory-ui/common.mjs';

export function writeBrowserEvidenceFixture({ log, environment }, { head, tree, scenarios, files = {} }) {
  const output = environment.TIMEY_FLOW_BROWSER_OUTPUT;
  mkdirSync(output, { recursive: true });
  const retained = Object.entries(files).map(([name, bytes]) => {
    writeFileSync(join(output, name), bytes);
    return { name, sha256: digest(bytes) };
  });
  const passed = scenarios.every(({ passed }) => passed);
  writeFileSync(log, passed ? 'Fixture browser checks passed.\n' : 'Fixture browser assertion failed.\n');
  writeFileSync(
    join(output, 'results.json'),
    JSON.stringify({
      candidate: { revision: head, tree, clean: true },
      results: scenarios,
      files: retained,
      passed,
    })
  );
  if (!passed) throw Object.assign(Error('Focused browser assertion failed.'), { exitCode: 1 });
}
