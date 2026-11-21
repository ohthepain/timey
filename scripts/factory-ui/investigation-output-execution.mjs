import { InvestigationOutputs } from './investigation-outputs.mjs';
import { investigationOutputKinds } from './investigation-flow.mjs';
import { requireThat } from './common.mjs';

function reportResult(outputs, context, manifest) {
  const saved = outputs.reports
    .list()
    .find(
      (report) => report.publicationId === context.publicationId && report.source.issueId === context.source.issueId
    );
  if (saved) return saved;
  const values = manifest.values || {};
  return outputs.reports.publish({
    ...context,
    title: values.reportTitle,
    report: manifest.files?.report,
    additionalFindings: values.additionalFindings,
    inspectedRevisions: values.inspectedRevisions,
  });
}

function savedIssueReference(item) {
  const result = item.result || item;
  return { key: item.key, issueId: result.issueId, relation: result.relation || 'created' };
}

const retainedIssue = (item) => !item.result?.deleted;

function issueResults(outputs, context, manifest) {
  const values = manifest.values || {};
  if (Array.isArray(values.issues))
    outputs.registerIssues({
      source: context.source,
      items: values.issues.filter(retainedIssue).map(savedIssueReference),
    });
  const items = outputs.ledger(context.source).saved.items;
  requireThat(
    items.length > 0 || Array.isArray(values.issues),
    'Return saved issue references or an explicit empty issues list.'
  );
  requireThat(
    !items.some((item) => item.error || !item.result),
    'Some findings remain unsaved. Retry to create only the remaining issues.'
  );
  return items.map(({ key, result }) => ({ key, ...result }));
}

export function investigationOutputExecution(service, ctx, workspace) {
  if (!investigationOutputKinds.has(ctx.block.kind)) return null;
  requireThat(service.flows, 'The investigation output needs its owning flow controller.');
  const outputs = new InvestigationOutputs(service.flows);
  const context = {
    kind: ctx.block.kind,
    source: ctx.attempt.investigationSource,
    publicationId: ctx.attempt.publicationId,
    attemptId: ctx.attempt.id,
    workspace: workspace.checkout,
    folder: ctx.flow.investigation?.folder,
  };
  const tools = outputs.tools(context);
  const complete = {
    'generate-report'(manifest) {
      const report = reportResult(outputs, context, manifest);
      return {
        reportId: report.id,
        additionalFindings: report.additionalFindings,
        inspectedRevisions: report.inspectedRevisions,
        reportEvidence: report.evidence,
      };
    },
    'create-issues'(manifest) {
      return { issues: issueResults(outputs, context, manifest) };
    },
  };
  return {
    tools: {
      definitions: tools.definitions,
      invoke(name, input) {
        ctx.signal.throwIfAborted();
        return tools.invoke(name, input);
      },
    },
    complete(manifest, retained) {
      if (retained.status === 'blocked') return;
      Object.assign(retained.artifacts.values, complete[context.kind](manifest));
    },
  };
}
