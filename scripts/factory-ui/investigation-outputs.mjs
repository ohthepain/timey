import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { digest, requireThat, writeJson } from './common.mjs';
import { InvestigationReports, checkedInvestigationSource, reportPublicationSchema } from './investigation-reports.mjs';
import { validateInvestigationProposal } from './investigation-proposals.mjs';
import { defaultIssueFolder, requireIssueFolder } from './issue-folder-settings.mjs';
import { projectIssueRecords } from './project-home-stats.mjs';
import { investigationProposalDescription } from './flow-followups.mjs';

const pending = new Map();
const normalizedTitle = (value) =>
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const stableId = (value) => digest(value).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
const findingSchema = z
  .object({
    key: z.string().regex(/^[\w.-]{1,160}$/),
    title: z.string(),
    type: z.enum(['bug', 'feature', 'investigation']),
    description: z.string(),
    reason: z.string(),
    verification: z.string(),
    existingIssueId: z.string().optional(),
  })
  .strict();
const issuesSchema = z.object({ items: z.array(findingSchema).max(100), folder: z.string().optional() }).strict();

const savedIssuesSchema = z
  .array(
    z
      .object({
        key: z.string().regex(/^[\w.-]{1,160}$/),
        issueId: z.string().min(1),
        relation: z.enum(['created', 'linked']),
      })
      .strict()
  )
  .max(100);

function requireSameFinding(previous, draft, folder) {
  requireThat(
    normalizedTitle(previous.title) === normalizedTitle(draft.title),
    'Retry the saved finding identity with its original title.'
  );
  if (previous.folder)
    requireThat(previous.folder === folder, 'Retry the saved finding identity in its original folder.');
}

function stageFinding(saved, draft, folder, source) {
  const previous = savedFinding(saved.items, draft);
  if (previous) return requireSameFinding(previous, draft, folder);
  saved.items.push({
    ...draft,
    folder,
    requestId: stableId(JSON.stringify([source.issueId, source.attemptId, draft.key])),
  });
}

function requireCreatedSource(reference, issue, source) {
  if (reference.relation !== 'created') return;
  requireThat(
    issue.state === 'needs-approval' &&
      issue.source_issue === source.issueId &&
      issue.source_attempt === source.attemptId,
    'New skill-saved issues must need approval and retain the original investigation source.'
  );
}

function registeredItem(previous, reference, issue) {
  const item = previous || { key: reference.key, title: issue.title };
  item.result = { issueId: issue.id, relation: reference.relation };
  delete item.error;
  return item;
}

function registerReference(saved, source, issues, reference) {
  const previous = saved.items.find(({ key }) => key === reference.key);
  if (previous?.result) {
    requireThat(previous.result.issueId === reference.issueId, 'This finding already has a different saved outcome.');
    return;
  }
  const issue = issues.find(({ id }) => id === reference.issueId);
  requireThat(issue, 'Return an existing saved issue reference.');
  requireCreatedSource(reference, issue, source);
  const item = registeredItem(previous, reference, issue);
  if (!previous) saved.items.push(item);
}

function matchingIssue(issues, item) {
  const match = item.existingIssueId
    ? issues.find(({ id }) => id === item.existingIssueId)
    : issues.find(({ title }) => normalizedTitle(title) === normalizedTitle(item.title));
  requireThat(!item.existingIssueId || match, 'Choose an existing issue before linking matching work.');
  return match;
}

function legacyResult(entry) {
  if (entry.result) return { relation: 'created', ...entry.result };
  if (entry.issueId || entry.deleted)
    return { issueId: entry.issueId, deleted: entry.deleted === true, relation: 'created' };
  return undefined;
}

function legacyItem(entry) {
  return {
    ...entry,
    ...entry.draft,
    key: entry.key || entry.id,
    requestId: entry.requestId || entry.id,
    result: legacyResult(entry),
  };
}

function mergeLegacyItem(current = {}, authoritative) {
  const merged = {
    ...current,
    ...authoritative,
    result: current.result ?? authoritative.result,
    error: current.error ?? authoritative.error,
  };
  if (merged.result) delete merged.error;
  return merged;
}

function mergeLegacyItems(current, authoritative) {
  const items = new Map(current.map((item) => [item.key, item]));
  for (const item of authoritative) items.set(item.key, mergeLegacyItem(items.get(item.key), item));
  return [...items.values()];
}

function legacyProposals(receipt) {
  return (receipt.proposals || []).map((entry) => ({
    ...legacyItem(entry),
    folder: entry.folder ?? receipt.folder,
    captureDescription: investigationProposalDescription(entry.draft ?? entry, receipt.source),
  }));
}

function legacyItems(source, directory) {
  const receipts = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')))
        .filter((entry) => entry.source?.issueId === source.issueId && entry.source?.attemptId === source.attemptId)
        .flatMap(legacyProposals)
    : [];
  return mergeLegacyItems((source.legacyFollowups || []).map(legacyItem), receipts);
}

function savedFinding(items, draft) {
  return items.find(
    (item) =>
      item.key === draft.key ||
      (item.result && item.title && normalizedTitle(item.title) === normalizedTitle(draft.title))
  );
}

function findingDescription(item, source) {
  return item.captureDescription || issueDescription(item, source);
}

function savedReportReference({ id, publicationId, attemptId, title, publishedAt }) {
  return { id, publicationId, attemptId, title, publishedAt };
}

function issueDescription(item, source) {
  return [
    item.title,
    item.description,
    '## Why',
    item.reason,
    '## Requested proof',
    item.verification,
    '## Source investigation',
    source.issueId,
    'Investigation run: ' + source.attemptId,
    'Inspected source revision: ' + source.revision,
  ].join('\n\n');
}

export class InvestigationOutputs {
  constructor(flows) {
    this.flows = flows;
    this.directory = join(flows.service.root, '.issues/factory-ui/investigation-outputs');
    this.reports = new InvestigationReports(flows.service.root);
  }
  ledger(source) {
    const key = digest(JSON.stringify([source.issueId, source.attemptId]));
    const path = join(this.directory, key + '.json');
    const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { source, items: [] };
    saved.items = mergeLegacyItems(
      saved.items,
      legacyItems(source, join(this.flows.service.root, '.issues/flows/investigation-followups'))
    );
    return { path, saved };
  }
  async createIssues(input) {
    const source = checkedInvestigationSource(input.source);
    const parsed = issuesSchema.parse({ items: input.items, ...(input.folder && { folder: input.folder }) });
    const { path } = this.ledger(source);
    requireThat(!pending.has(path), 'Issue creation for this inquiry is already saving.');
    const task = this.saveIssues(source, parsed);
    pending.set(path, task);
    try {
      return await task;
    } finally {
      pending.delete(path);
    }
  }
  async saveIssues(source, input) {
    const { path, saved } = this.ledger(source);
    const folder = requireIssueFolder(
      this.flows.service.root,
      input.folder || defaultIssueFolder(this.flows.service.root).name
    ).name;
    requireThat(
      new Set(input.items.map(({ key }) => key)).size === input.items.length,
      'Use each finding identity once.'
    );
    const drafts = input.items.map((item) => ({
      ...validateInvestigationProposal(item),
      key: item.key,
      existingIssueId: item.existingIssueId,
    }));
    mkdirSync(this.directory, { recursive: true });
    for (const draft of drafts) stageFinding(saved, draft, folder, source);
    writeJson(path, saved);
    for (const draft of drafts) {
      await this.saveIssue(savedFinding(saved.items, draft), source);
      writeJson(path, saved);
    }
    return structuredClone(saved);
  }
  existingIssues() {
    const records = [...this.flows.issues(), ...projectIssueRecords(this.flows.service.root)];
    return [...new Map(records.map((item) => [item.id, item])).values()];
  }
  registerIssues(input) {
    const source = checkedInvestigationSource(input.source);
    const references = savedIssuesSchema.parse(input.items);
    requireThat(
      new Set(references.map(({ key }) => key)).size === references.length,
      'Use each finding identity once.'
    );
    const { path, saved } = this.ledger(source);
    const issues = this.existingIssues();
    for (const reference of references) registerReference(saved, source, issues, reference);
    mkdirSync(this.directory, { recursive: true });
    writeJson(path, saved);
    return structuredClone(saved);
  }
  async saveIssue(item, source) {
    if (item.result) return;
    try {
      const match = matchingIssue(this.existingIssues(), item);
      item.result = match ? { issueId: match.id, relation: 'linked' } : await this.captureFinding(item, source);
      delete item.error;
    } catch (error) {
      item.error = error.message;
    }
  }
  async captureFinding(item, source) {
    const result = await this.flows.capture({
      requestId: item.requestId,
      type: item.type,
      folder: item.folder,
      needsApproval: true,
      sourceIssue: source.issueId,
      sourceAttempt: source.attemptId,
      description: findingDescription(item, source),
    });
    const outcome = {
      issueId: result.issue?.id || result.issueId,
      deleted: result.deleted === true,
      relation: 'created',
    };
    requireThat(outcome.issueId || outcome.deleted, 'The saved issue did not return its identity.');
    return outcome;
  }
  tools(context) {
    const registry = {
      investigation_outputs: {
        description:
          'Read this inquiry’s retained saved outcomes and stable finding identities before retries. Reading starts no work.',
        schema: z.object({}).strict(),
        run: () => ({
          source: context.source,
          existingIssues: this.existingIssues().map(({ id, title, state, content }) => ({ id, title, state, content })),
          issues: this.ledger(context.source).saved.items,
          reports: this.reports
            .list()
            .filter(
              ({ source }) => source.issueId === context.source.issueId && source.attemptId === context.source.attemptId
            )
            .map(savedReportReference),
        }),
      },
    };
    if (context.kind === 'generate-report')
      registry.report_publish = {
        description:
          'Retain a skill-saved report and evidence in Timey Reports, attached to this exact inquiry and output attempt. Retry recovers this publication. Save the report file first.',
        schema: reportPublicationSchema,
        run: (input) =>
          this.reports.publish({
            ...input,
            source: context.source,
            publicationId: context.publicationId,
            attemptId: context.attemptId,
            workspace: context.workspace,
          }),
      };
    if (context.kind === 'create-issues')
      registry.investigation_issues_save = {
        description:
          'Save actionable findings as Needs approval, or link matching existing issues unchanged. Stable finding keys and receipts preserve successful creations across partial failures and replacement skills. Approval starts no work.',
        schema: issuesSchema,
        run: (input) => this.createIssues({ ...input, source: context.source, folder: input.folder || context.folder }),
      };
    return {
      definitions: Object.entries(registry).map(([name, value]) => ({
        name,
        description: value.description,
        inputSchema: z.toJSONSchema(value.schema, { target: 'draft-7' }),
      })),
      invoke(name, args) {
        requireThat(Object.hasOwn(registry, name), 'Choose a registered investigation output tool.');
        const entry = registry[name];
        return entry.run(entry.schema.parse(args));
      },
    };
  }
}
