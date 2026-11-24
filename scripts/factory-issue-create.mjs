import { readFileSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { readRuntime } from './factory-ui/runtime.mjs';
import { requireThat } from './factory-ui/common.mjs';

const requestSchema = z
  .object({
    requestId: z.string().uuid(),
    description: z.string().trim().min(1).max(16000),
    folder: z.string().min(1).optional(),
    type: z.enum(['bug', 'feature', 'investigation']).optional(),
    storageProfile: z.string().min(1).max(100).default('default'),
  })
  .strict();

async function createIssueOnServer(project, address, input) {
  const request = requestSchema.parse(input);
  const runtime = await readRuntime(address);
  requireThat(runtime.mode === 'live', 'Select a live Factory server to create the issue.');
  requireThat(
    realpathSync(runtime.project) === realpathSync(project),
    'The server belongs to another project. No issue was created.'
  );
  const response = await fetch(runtime.url + '/api/flow-action', {
    method: 'POST',
    headers: {
      cookie: runtime.sessionCookie,
      origin: runtime.url,
      'content-type': 'application/json',
      'x-factory-action': 'manual',
    },
    body: JSON.stringify({ ...request, action: 'capture' }),
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  requireThat(
    response.ok && !result.error,
    result.error || 'Issue creation was not confirmed. Retry the same request file.'
  );
  requireThat(result.issue?.id, 'The server returned no issue identity. Retry the same request file.');
  return {
    status: 'created',
    requestId: request.requestId,
    issueId: result.issue.id,
    issueNumber: result.issue.issueNumber,
    url: runtime.url + '/?issue=' + encodeURIComponent(result.issue.id),
    started: false,
  };
}

export async function runIssueCreate(project, args) {
  if (args.length === 1 && args[0] === '--help')
    return (
      'Usage: pnpm run factory -- issue-create REQUEST.json --url http://127.0.0.1:PORT\n' +
      'REQUEST.json: {"requestId":"UUID","description":"Title\\n\\nAgreed scope and acceptance criteria"}\n' +
      'Optional fields: folder, type (bug, feature, investigation), storageProfile.\n' +
      'Creates an idle issue on the matching live server. Reuse the request file when retrying.'
    );
  requireThat(args.length === 3 && args[1] === '--url', 'Use issue-create --help for the supported command.');
  return createIssueOnServer(project, args[2], JSON.parse(readFileSync(args[0], 'utf8')));
}
