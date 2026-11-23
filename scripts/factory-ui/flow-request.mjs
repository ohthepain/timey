import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTextDiscussionRuntime } from './discussion-codex.mjs';
import { digest, requireThat } from './common.mjs';
import { redactValue } from './activity.mjs';

import { issueTypes } from './flow-definitions.mjs';

export async function clarifyRequest(root, definition, attempt, signal, discussion = createTextDiscussionRuntime) {
  signal.throwIfAborted();
  requireThat(definition?.usable && definition.prompt, 'Request is missing its Markdown system prompt.');
  const values = definition.artifacts.filter(({ kind, key }) => kind === 'value' && key !== 'wording');
  requireThat(
    values.some(({ key }) => key === 'type'),
    'Request Markdown is missing the type artifact.'
  );
  const startedAt = Date.now();
  const diagnostic = { version: 1, stage: 'starting-provider', transport: [], items: {} };
  const session = discussion(undefined, {
    root,
    model: attempt.modelSettings?.model,
    onEvent: ({ method, params = {} }) => {
      if (
        method === 'ui/transportPhase' &&
        ['initialize', 'thread/start', 'turn/start', 'turn/completed'].includes(params.method) &&
        ['requested', 'replied', 'waiting', 'rejected', 'finished'].includes(params.phase)
      ) {
        diagnostic.transport.push({ method: params.method, phase: params.phase, elapsedMs: Date.now() - startedAt });
        diagnostic.transport = diagnostic.transport.slice(-32);
      }
      if (method === 'item/started' && ['commandExecution', 'agentMessage', 'reasoning'].includes(params.item?.type))
        diagnostic.items[params.item.type] = (diagnostic.items[params.item.type] || 0) + 1;
    },
  });
  let timer;
  let cancel;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Error('Request clarification timed out. Save or refresh Request to try again.')),
        90_000
      );
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    const output = await Promise.race([
      timeout,
      (async () => {
        await session.begin({ task: 'Clarify the request in the supplied fields.' }, definition.prompt);
        signal.throwIfAborted();
        diagnostic.stage = 'generating-fields';
        return session.ask(
          JSON.stringify(
            Object.fromEntries(
              attempt.details.filter((detail) => detail.value !== undefined).map(({ key, value }) => [key, value])
            )
          ),
          [],
          {
            type: 'object',
            properties: Object.fromEntries(
              values.map(({ key }) => [key, key === 'type' ? { type: 'string', enum: issueTypes } : { type: 'string' }])
            ),
            required: values.map(({ key }) => key),
            additionalProperties: false,
          }
        );
      })(),
    ]);
    signal.throwIfAborted();
    diagnostic.stage = 'parsing-response';
    const fields = redactValue(JSON.parse(output));
    requireThat(issueTypes.includes(fields.type), 'Request clarification is missing a valid issue type.');
    const published = Object.fromEntries(
      values.flatMap(({ key }) => (typeof fields[key] === 'string' ? [[key, fields[key]]] : []))
    );
    if (definition.artifacts.some(({ key }) => key === 'wording'))
      published.wording = attempt.details.find(({ key }) => key === 'wording')?.value || '';
    const path = join(root, '.issues/factory-ui/flow-evidence', attempt.id, 'output.txt');
    const body = JSON.stringify(published, null, 2);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode: 0o600 });
    const proof = { path, label: 'Clarified request', sha256: digest(body) };
    return {
      summary: published.goal || 'Clarified the request.',
      output: body,
      evidence: [proof],
      artifacts: { values: published, files: { response: proof } },
    };
  } catch (error) {
    const path = join(root, '.issues/factory-ui/flow-evidence', attempt.id, 'diagnostic.json');
    const body = JSON.stringify({ ...diagnostic, elapsedMs: Date.now() - startedAt }, null, 2);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode: 0o600 });
    error.evidence = [
      ...(error.evidence || []),
      { path, label: 'Request clarification diagnostic', sha256: digest(body) },
    ];
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    session.close();
  }
}
