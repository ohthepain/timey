import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export function isInvestigation(issue, flow) {
  const request = flow?.blocks?.find(({ kind }) => kind === 'request');
  return (request?.data?.fields?.type || flow?.routeType || issue?.request_type) === 'investigation';
}

export function investigationReport(root, id, content) {
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = header ? parse(header[1]) : {};
  const path = join(root, '.issues/flows', id, 'flow.json');
  const flow = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  return isInvestigation(metadata, flow);
}
