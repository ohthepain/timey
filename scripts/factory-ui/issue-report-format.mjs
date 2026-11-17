import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const toolingRoot = fileURLToPath(new URL('../../', import.meta.url));
const formatter = fileURLToPath(new URL('../../node_modules/.bin/vp', import.meta.url));
const config = fileURLToPath(new URL('../../.oxfmtrc.json', import.meta.url));

export function formatIssueReport(content) {
  return execFileSync(formatter, ['fmt', '--config', config, '--stdin-filepath=issue-report.md'], {
    cwd: toolingRoot,
    input: content,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function originalRequestSection(wording) {
  return '<!-- prettier-ignore-start -->\n\n## Original request\n\n' + wording + '\n\n<!-- prettier-ignore-end -->';
}
