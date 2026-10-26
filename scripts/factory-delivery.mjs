import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { finalizeDelivery } from './factory-ui/delivery.mjs';
import { readRuntime } from './factory-ui/runtime.mjs';
import { requireThat } from './factory-ui/common.mjs';
try {
  const input = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  if (input.url) {
    const runtime = await readRuntime(input.url);
    requireThat(
      runtime.project === realpathSync(process.argv[2]) &&
        runtime.checkout === realpathSync(input.checkout) &&
        runtime.revision === input.revision &&
        runtime.mode === 'live' &&
        !runtime.sourceChanged,
      'The running site does not match this real issue and delivered checkout.'
    );
  }
  console.log(JSON.stringify(finalizeDelivery(process.argv[2], input)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
