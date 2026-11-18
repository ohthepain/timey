import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, requireThat, writeJson } from './common.mjs';
import { blockDefinitionId, definitionIdentity, latestCurrentAttempt } from './flow-block-data.mjs';
import { defaultIssueFolder, requireIssueFolder } from './issue-folder-settings.mjs';
import { redactValue } from './activity.mjs';
import { proposeInvestigationFollowups, validateInvestigationProposal } from './investigation-proposals.mjs';

function retainedResponse(root, attempt) {
  const file = attempt.artifacts?.files?.response ?? attempt.evidence?.find(({ key }) => key === 'response');
  requireThat(file?.path && file.sha256, 'The investigation needs a retained response with a digest.');
  const path = realpathSync(file.path);
  const base = realpathSync(join(root, '.issues/factory-ui/flow-evidence'));
  requireThat(
    path.startsWith(base + sep) && statSync(path).size <= 256000,
    'The retained findings are unavailable or too large.'
  );
  const bytes = readFileSync(path);
  requireThat(digest(bytes) === file.sha256, 'The retained findings changed. Run the investigation again.');
  return { text: bytes.toString('utf8'), evidence: { path, sha256: file.sha256 } };
}

function sourceSnapshot(flows, { issueId, blockId }) {
  const issue = flows.selected(issueId);
  const flow = flows.read(issue);
  const block = flow.blocks.find(({ id }) => id === blockId);
  requireThat(block?.kind === 'understand', 'Choose a completed Understand block.');
  const attempt = latestCurrentAttempt(block);
  const definition = flows.catalog.read().entries.find(({ id }) => id === blockDefinitionId(block));
  requireThat(
    definition && (!block.definitionChecksum || block.definitionChecksum === definitionIdentity(definition)),
    'The Understand definition changed. Refresh and run the investigation again.'
  );
  requireThat(
    attempt?.status === 'completed' && !flows.active.has(issue.id),
    'Finish the investigation before proposing follow-ups.'
  );
  const response = retainedResponse(flows.service.root, attempt);
  return {
    issueId,
    blockId,
    attemptId: attempt.id,
    basis: digest(JSON.stringify([issue.content, block, definitionIdentity(definition), response.evidence])),
    report: issue.content,
    findings: response.text,
    evidence: response.evidence,
  };
}

function proposalDescription(item, source) {
  return [
    item.title,
    item.description,
    '## Why',
    item.reason,
    '## Requested proof',
    item.verification,
    '## Source investigation',
    source.issueId,
    `Understand attempt: ${source.attemptId}`,
    `Retained findings: ${source.evidence.path}`,
    `SHA-256: ${source.evidence.sha256}`,
  ].join('\n\n');
}

function declinedProposals(flows) {
  const folder = join(flows.store.directory, 'captures');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const receipt = JSON.parse(readFileSync(join(folder, name), 'utf8'));
      return receipt.deleted
        ? [
            {
              id: receipt.id,
              title: receipt.title ?? receipt.metadata?.title,
              coverage:
                receipt.title || receipt.metadata?.title
                  ? 'Retained declined proposal title.'
                  : 'The declined proposal title was not retained.',
            },
          ]
        : [];
    });
}

export class FlowFollowups {
  constructor(flows, propose = proposeInvestigationFollowups) {
    this.flows = flows;
    this.propose = propose;
    this.busy = new Set();
    this.directory = join(flows.store.directory, 'investigation-followups');
  }

  path(source) {
    return join(this.directory, source.basis + '.json');
  }

  async action(input) {
    const source = sourceSnapshot(this.flows, input);
    const path = this.path(source);
    requireThat(!this.busy.has(path), 'This follow-up review is already busy.');
    this.busy.add(path);
    try {
      if (input.action === 'investigation-followups-preview') return await this.preview(source, path);
      requireThat(input.action === 'investigation-followups-create', 'Choose a follow-up action.');
      return await this.create(source, path, input);
    } finally {
      this.busy.delete(path);
    }
  }

  saved(source, path) {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    requireThat(saved.source.basis === source.basis, 'The investigation changed. Review its current findings again.');
    return saved;
  }

  async preview(source, path) {
    if (existsSync(path)) return this.saved(source, path);
    const existingIssues = this.flows.issues().map(({ id, title, state }) => ({ id, title, state }));
    const recommendations = await this.propose({
      ...source,
      existingIssues,
      declinedIssues: declinedProposals(this.flows),
    });
    requireThat(
      Array.isArray(recommendations) && recommendations.length <= 12,
      'The provider returned invalid follow-up proposals.'
    );
    requireThat(
      sourceSnapshot(this.flows, source).basis === source.basis,
      'The investigation changed while proposals were prepared. Review it again.'
    );
    const proposals = recommendations.map((item) => ({
      ...redactValue(validateInvestigationProposal(item)),
      id: randomUUID(),
    }));
    const preview = { source, folder: defaultIssueFolder(this.flows.service.root).name, proposals };
    mkdirSync(this.directory, { recursive: true });
    writeJson(path, preview);
    return preview;
  }

  async create(source, path, input) {
    requireThat(existsSync(path), 'Preview the findings before creating follow-up issues.');
    const saved = this.saved(source, path);
    requireThat(input.basis === source.basis, 'Review the current investigation before creating issues.');
    requireThat(
      Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 12,
      'Select follow-up issues to create.'
    );
    requireThat(
      new Set(input.items.map(({ id }) => id)).size === input.items.length,
      'Select each proposal only once.'
    );
    const folder = requireIssueFolder(this.flows.service.root, input.folder).name;
    const drafts = input.items.map((item) => {
      const proposal = saved.proposals.find(({ id }) => id === item.id);
      requireThat(proposal, 'Choose a saved follow-up proposal.');
      const draft = validateInvestigationProposal(item);
      const identity = digest(JSON.stringify([draft, folder]));
      requireThat(
        !proposal.identity || proposal.identity === identity,
        'A submitted proposal cannot change. Retry its saved wording and folder.'
      );
      return { proposal, draft, identity };
    });
    for (const { proposal, draft, identity } of drafts) {
      proposal.identity = identity;
      proposal.draft = draft;
      proposal.folder = folder;
    }
    writeJson(path, saved);
    for (const { proposal, draft } of drafts) {
      if (proposal.result) continue;
      try {
        requireThat(
          sourceSnapshot(this.flows, source).basis === source.basis,
          'The investigation changed. Review it again.'
        );
        const result = await this.flows.capture({
          requestId: proposal.id,
          type: draft.type,
          folder,
          needsApproval: true,
          sourceIssue: source.issueId,
          sourceAttempt: source.attemptId,
          description: proposalDescription(draft, source),
        });
        proposal.result = { issueId: result.issue?.id ?? result.issueId, deleted: result.deleted === true };
        delete proposal.error;
      } catch (error) {
        proposal.error = redactValue(error.message);
      }
      writeJson(path, saved);
    }
    return saved;
  }
}
