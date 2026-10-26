import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

// Stream during execution; retain separate channels for structured audit assessment.
export function runVerificationProcess(command, args, options, log) {
  writeFileSync(log, '');
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = { stdout: '', stderr: '', error: null, status: null };
    const heartbeat = setInterval(() => console.log(`RUNNING ${command}: ${log}`), 15000);
    for (const channel of ['stdout', 'stderr'])
      child[channel].on('data', (chunk) => {
        result[channel] += chunk;
        appendFileSync(log, chunk);
        process[channel].write(chunk);
      });
    child.on('error', (error) => {
      result.error = error;
    });
    child.on('close', (status) => {
      clearInterval(heartbeat);
      resolve({ ...result, status });
    });
  });
}
