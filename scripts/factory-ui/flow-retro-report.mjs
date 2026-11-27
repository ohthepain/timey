import { commitStoredReport } from './stores/report-access.mjs';

const typeLabels = { investigation: 'Investigation', bug: 'Bug fix', feature: 'Improvement' };

export function withRetroSummary(content, closureId, summary, followups) {
  const marker = `<!-- factory-retro ${closureId} -->`;
  if (content.includes(marker)) return content;
  const links = followups.map(({ id, title, type }) => {
    const label = title.replace(/[\\`*_\[\]<>&]/g, '\\$&');
    return `- [${label}](/?issue=${encodeURIComponent(id)}) (**${typeLabels[type]}**)`;
  });
  return (
    [
      content.trimEnd(),
      `## Retro\n\n${marker}`,
      summary.trim(),
      '### Follow-up issues',
      links.join('\n') || 'No follow-up issues were created.',
    ].join('\n\n') + '\n'
  );
}
export async function saveRetroReport(service, issue, report) {
  if (service.sharedIssues && issue.location === 'closed') {
    return service.sharedIssues.saveRetroReport(issue, report);
  } else if (report !== issue.content) {
    await commitStoredReport(service.root, issue, report, { purpose: 'closure' });
  }
}
