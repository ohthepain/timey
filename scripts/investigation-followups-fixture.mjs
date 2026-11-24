import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './factory-ui/common.mjs';
import { importBrowserIssue } from './flow-browser-fixture.mjs';
import { makeBlock } from './factory-ui/flow-store.mjs';

export const investigationProposals = [
  {
    title: 'Retain actionable validation diagnostics',
    type: 'bug',
    description: 'Retain sanitized validation reasons when publication fails.',
    reason: 'The investigation found discarded response details.',
    verification: 'A controlled 422 exposes the validation message without credentials.',
  },
  {
    title: 'Explain candidate revisions before publication',
    type: 'feature',
    description: 'Show selected and pushed candidate revisions before publication.',
    reason: 'Recorded attempts used different candidates.',
    verification: 'The publication preview shows both revisions accurately.',
  },
];

export async function seedInvestigation(flows, id = '20261118-understand-fixture') {
  const root = flows.service.root;
  await importBrowserIssue(
    root,
    id,
    `---\nid: ${id}\ntitle: Understand publication failure\nstate: backlog\nrequest_type: investigation\ncreated: 2026-11-18T12:00:00Z\n---\n\n## Original request\n\nInvestigate the missing validation diagnostics.\n`
  );
  const issue = flows.selected(id);
  const catalog = flows.catalog.read().entries;
  const flow = flows.read(issue, catalog);
  const block =
    flow.blocks.find((item) => item.kind === 'understand') ?? makeBlock('understand', ['request'], false, catalog);
  if (!flow.blocks.includes(block)) flow.blocks.push(block);
  const attemptId = randomUUID();
  const directory = join(root, '.issues/factory-ui/flow-evidence', attemptId);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'output.txt');
  const findings =
    'The validation reason was discarded. Preserve future diagnostics and explain candidate revisions. Historical response bodies cannot be recovered.\n';
  writeFileSync(path, findings);
  const evidence = { path, label: 'Block response', sha256: digest(findings) };
  block.attempts = [
    {
      id: attemptId,
      status: 'completed',
      startedAt: '2026-11-18T12:00:00Z',
      endedAt: '2026-11-18T12:01:00Z',
      output: findings,
      summary: 'Investigation completed.',
      artifacts: { values: {}, files: { response: evidence } },
      evidence: [evidence],
    },
  ];
  await flows.store.save(flow, flow.revision);
  return { issueId: id, blockId: block.id, attemptId, evidence };
}
