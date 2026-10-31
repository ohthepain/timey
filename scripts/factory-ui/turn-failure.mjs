export function turnFailure(turn) {
  let detail = turn.error?.message;
  try {
    const parsed = JSON.parse(detail);
    detail = parsed.error?.message || parsed.message || detail;
  } catch {}
  return detail
    ? `Codex turn ${turn.status}: ${detail}`
    : `Codex turn ${turn.status}. Review its progress before continuing.`;
}
