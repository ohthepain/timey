import { readRuntime } from './factory-ui/runtime.mjs';
try {
  console.log(JSON.stringify(await readRuntime(process.argv[2])));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
