import { execFile, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { finishGitHubCall, startGitHubCall } from './github-call-history.mjs';
import { githubCallMetadata, networkFailure } from './github-http.mjs';

const durationUnits = { h: 3600000, m: 60000, s: 1000, ms: 1, µs: 0.001, ns: 0.000001 };

function durationMs(value) {
  return Array.from(value.matchAll(/([\d.]+)(ms|µs|ns|h|m|s)/g)).reduce(
    (total, [, amount, unit]) => total + Number(amount) * durationUnits[unit],
    0
  );
}

function tracedEnvironment(env) {
  return { ...env, GH_DEBUG: 'api', GH_FORCE_TTY: '', GH_PAGER: 'cat', NO_COLOR: '1' };
}

function requestStart(line) {
  const match = /^\* Request at (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?) ([+-]\d{4})/.exec(line);
  return match && Date.parse(`${match[1]}T${match[2]}${match[3]}`);
}

function cliTrace(repository, args) {
  const graphqlOperation = ['pr', 'run'].includes(args[0]) ? args.slice(0, 2).join(' ') : null;
  let request;
  let diagnostic = '';

  function complete(durationMs, failure) {
    if (!request.metadata) return;
    const id = request.id ?? startGitHubCall({ ...request.metadata, startedAt: request.startedAt });
    finishGitHubCall(id, { durationMs, status: request.status, failure });
  }

  return {
    line(line) {
      const startedAt = requestStart(line);
      if (Number.isFinite(startedAt)) {
        request = { startedAt };
      } else if (request) {
        readRequestLine(line);
      } else if (!line.startsWith('* ')) {
        diagnostic += line + '\n';
      }
    },
    finish(killed) {
      if (request) complete(Date.now() - request.startedAt, killed ? 'Timed out' : 'Network error');
      return diagnostic.trimEnd();
    },
  };

  function readRequestLine(line) {
    if (line.startsWith('> ')) return readMethod(line);
    if (line.startsWith('< HTTP/')) return readStatus(line);
    if (line.startsWith('* ')) readTraceEvent(line);
  }

  function readMethod(line) {
    const method = /^> (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+ HTTP\/[\d.]+$/.exec(line)?.[1];
    if (!method || !request.metadata) return;
    request.metadata = githubCallMetadata(request.target, method, repository);
    labelGraphQL(request.metadata, graphqlOperation);
    request.id = startGitHubCall({ ...request.metadata, startedAt: request.startedAt });
  }

  function readStatus(line) {
    const status = /^< HTTP\/[\d.]+ (\d{3})(?: |$)/.exec(line)?.[1];
    if (!status || request.status) return;
    request.status = Number(status);
  }

  function readTraceEvent(line) {
    if (line.startsWith('* Request to ')) {
      request.target = line.slice('* Request to '.length);
      request.metadata = githubCallMetadata(request.target, 'HTTP', repository);
    } else if (line.startsWith('* Request took ')) {
      complete(durationMs(line.slice('* Request took '.length)), request.failure);
      request = undefined;
    } else if (reportsNetworkFailure(line, request.status)) {
      request.failure = networkFailure(line);
    }
  }
}

function labelGraphQL(metadata, operation) {
  if (metadata.operation === 'POST /graphql' && operation) metadata.operation += ' · ' + operation;
}

function reportsNetworkFailure(line, status) {
  return line.startsWith('* cannot read body:') || (!status && !line.startsWith('* Using proxy:'));
}

function cleanError(error, diagnostic, stdout) {
  error.stderr = diagnostic;
  error.stdout = stdout;
  error.message = error.message.split('\n')[0] + (diagnostic ? '\n' + diagnostic : '');
  return error;
}

export function runGitHubCli(args, options, repository) {
  const trace = cliTrace(repository, args);
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { ...options, env: tracedEnvironment(options.env) }, (error, stdout) => {
      const diagnostic = trace.finish(error?.killed);
      if (error) reject(cleanError(error, diagnostic, stdout));
      else resolve(stdout);
    });
    createInterface({ input: child.stderr }).on('line', trace.line);
  });
}

export function runGitHubCliSync(args, options, repository) {
  const trace = cliTrace(repository, args);
  const result = spawnSync('gh', args, {
    ...options,
    env: tracedEnvironment(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  for (const line of String(result.stderr ?? '').split(/\r?\n/)) trace.line(line);
  const diagnostic = trace.finish(result.error?.code === 'ETIMEDOUT');
  assertCliSuccess(result, diagnostic);
  return result.stdout;
}

function assertCliSuccess(result, diagnostic) {
  if (result.error) throw cleanError(result.error, diagnostic, result.stdout);
  if (result.status === 0) return;
  throw Object.assign(Error(diagnostic || 'GitHub CLI failed.'), {
    status: result.status,
    signal: result.signal,
    stderr: diagnostic,
    stdout: result.stdout,
  });
}
