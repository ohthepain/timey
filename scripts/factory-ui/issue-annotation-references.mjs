import { parse } from 'yaml';

export const annotationPrefix = (issueId) => 'issue-annotations/' + issueId + '/';
const incomingPrefix = (issueId) => 'issue-incoming/' + issueId + '/';

export const retainingTypes = ['reference'];

export function incomingKey({ issueId, type, targetIssueId }) {
  return retainingTypes.includes(type) ? incomingPrefix(targetIssueId) + issueId + '/' + type : null;
}

export function incomingReferences(reader, issueId) {
  return reader.list(incomingPrefix(issueId), ({ value }) => value);
}

function reportTitle(report) {
  const [, header = ''] = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(report) ?? [];
  return parse(header)?.title;
}

export async function namedReference(readIssue, reference) {
  try {
    const { report, number } = await readIssue(reference.issueId);
    return { ...reference, title: reportTitle(report), issueNumber: number };
  } catch {
    return reference;
  }
}
