import { redactValue } from './activity.mjs';
import { infrastructureFailure } from './strategy-repair.mjs';

function safeText(value, token) {
  if (typeof value !== 'string') return undefined;
  let text = redactValue(value);
  if (token) text = text.split(token).join('[redacted]');
  return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]').slice(0, 1600);
}

function responseDetails(error, token) {
  let body;
  try {
    body = JSON.parse(error.stdout || '');
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const message = safeText(body.message, token);
  const errors = (Array.isArray(body.errors) ? body.errors : []).slice(0, 20).map((entry) => {
    if (typeof entry === 'string') return { message: safeText(entry, token) };
    return Object.fromEntries(
      ['resource', 'field', 'code', 'message']
        .filter((key) => typeof entry?.[key] === 'string')
        .map((key) => [key, safeText(entry[key], token)])
    );
  });
  return message || errors.length ? { message, errors } : null;
}

export function safeGitHubFailure(error, status, session) {
  const response = responseDetails(error, session.token);
  const reason = [response?.message, ...(response?.errors || []).map((entry) => entry.message)]
    .filter(Boolean)
    .join(': ');
  const instruction = status === '422' ? ' Review the validation details before retrying this request.' : '';
  const safe = Error(
    'Factory GitHub App request failed' +
      (status ? ` (HTTP ${status})` : '') +
      (reason ? ': ' + reason : '.') +
      instruction
  );
  safe.githubStatus = Number(status) || null;
  safe.githubResponse = response;
  safe.transient = status === '422' ? false : infrastructureFailure(error);
  return safe;
}
