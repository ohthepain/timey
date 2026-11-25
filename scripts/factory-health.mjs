import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { latestFactoryHeapCrash } from './factory-ui/heap-crash.mjs';
import { readRuntime } from './factory-ui/runtime.mjs';

async function checkServer(root, url) {
  try {
    const runtime = await readRuntime(url, () => {}, false, { timeoutMs: 3000 });
    if (runtime.project !== root || runtime.mode !== 'live')
      throw Error('This address does not serve the live Factory for this project.');
    console.log(`Factory is reachable at ${runtime.url} (PID ${runtime.pid}).`);
  } catch (error) {
    console.error(`Factory is unavailable at ${url}. ${error.message}`);
    process.exitCode = 1;
  }
}

const { values } = parseArgs({
  options: { project: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:52995' } },
});
const root = realpathSync(values.project ?? process.cwd());
await checkServer(root, values.url);
const crash = latestFactoryHeapCrash(root);
if (crash) {
  const detail = crash.time ? `${crash.time}, PID ${crash.pid}` : `log last updated ${crash.logUpdatedAt}`;
  console.log(`Latest recorded Factory Node heap crash (${detail}).\n${crash.path}`);
} else {
  console.log('No recorded Factory Node heap crash found.');
}
