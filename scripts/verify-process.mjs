import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

// Own the spawned process group; cancellation never discovers PIDs by ordering or name.
export function runVerificationProcess(command, args, options, log) {
  writeFileSync(log, '');
  const { signal, ...spawnOptions } = options;
  if (signal?.aborted)
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: 'Verification cancelled.' });
  return new Promise((resolve) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { ...spawnOptions, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = {
      stdout: '',
      stderr: '',
      error: null,
      status: null,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    };
    let escalation;
    const terminate = (signalName) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch (error) {
        if (error.code !== 'ESRCH') result.error = 'Could not stop the owned verification process.';
      }
    };
    const abort = () => {
      result.error = 'Verification cancelled. No remaining checks were started.';
      terminate('SIGTERM');
      escalation = setTimeout(() => terminate('SIGKILL'), 2000);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const heartbeat = setInterval(() => console.log(`RUNNING ${command}: ${log}`), 15000);
    for (const channel of ['stdout', 'stderr'])
      child[channel].on('data', (chunk) => {
        result[channel] += chunk;
        appendFileSync(log, chunk);
        process[channel].write(chunk);
      });
    child.on('error', (error) => {
      result.error = error.message;
    });
    child.on('close', (status) => {
      clearInterval(heartbeat);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      resolve({ ...result, status, finishedAt: new Date().toISOString() });
    });
    if (signal?.aborted) abort();
  });
}
