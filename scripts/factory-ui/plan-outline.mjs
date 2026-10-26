import { readPlan } from './plan-document.mjs';
import { digest, requireThat } from './common.mjs';

export function implementationPlans(issue, actions) {
  const text = [issue.content, ...actions.filter((a) => a.issues.includes(issue.id)).map((a) => a.worker_prompt)].join(
    '\n'
  );
  const paths = [...new Set(text.match(/docs\/plans\/[\w/-]+\.md/g) || [])];
  const explicit = paths.filter((path) => planPriority(path));
  return explicit.length ? explicit : paths;
}
function planPriority(path) {
  return Number(/implementation|implement/.test(path.split('/').pop()));
}

function planOutline(root, path) {
  const plan = readPlan(root, path),
    lines = plan.content.split('\n');
  let version = 'Implementation plan';
  const steps = [];
  for (const heading of planHeadings(plan.content)) {
    if (isVersion(heading.title)) version = heading.title;
    if (/^\d+[.)]\s/.test(heading.title)) steps.push(outlineStep(lines, heading, version));
  }
  return { ...plan, sha256: digest(plan.content), steps };
}
function planHeadings(content) {
  const plain = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (match) => match.replace(/[^\n]/g, ' '));
  return [...plain.matchAll(/^(#{2,4})\s+(.+?)\s*$/gm)].map((match) => ({
    title: match[2],
    depth: match[1].length,
    line: plain.slice(0, match.index).split('\n').length,
  }));
}
function outlineStep(lines, heading, version) {
  const start = heading.line - 1,
    end = sectionEnd(lines, start, heading.depth);
  return {
    id: `line-${heading.line}`,
    line: heading.line,
    version,
    title: heading.title,
    source: lines.slice(start, end).join('\n'),
  };
}
function isVersion(heading) {
  return /\bversion\b|^v\d|\brelease\b/i.test(heading) && !/^\d+[.)]\s/.test(heading);
}
function sectionEnd(lines, start, depth) {
  const index = lines.findIndex((line, n) => n > start && new RegExp(`^#{1,${depth}}\\s`).test(line));
  return index < 0 ? lines.length : index;
}
export function selectPlan(queue, issue, path) {
  requireThat(
    implementationPlans(issue, queue.actions).includes(path),
    'Choose an implementation plan linked to this issue.'
  );
  return planOutline(queue.root, path);
}
