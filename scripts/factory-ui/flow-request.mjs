import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDiscussionRuntime } from './discussion-codex.mjs';
import { digest, requireThat } from './common.mjs';
import { redactValue } from './activity.mjs';

import { issueTypes } from './flow-definitions.mjs';

export async function clarifyRequest(root, definition, attempt, signal, discussion = createDiscussionRuntime) {
  signal.throwIfAborted();
  requireThat(definition?.usable && definition.prompt, 'Request is missing its Markdown system prompt.');
  const values = definition.artifacts.filter(({ kind, key }) => kind === 'value' && key !== 'wording');
  requireThat(
    values.some(({ key }) => key === 'type'),
    'Request Markdown is missing the type artifact.'
  );
  const session = discussion(undefined, { root });
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
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    session.close();
  }
}
