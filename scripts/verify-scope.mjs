export function fallowAuditScope(changedFiles) {
  if (changedFiles.length === 0) return null;
  if (changedFiles.length === 1) return changedFiles[0];
  const parts = changedFiles.map((file) => file.split('/'));
  const minDepth = Math.min(...parts.map((segments) => segments.length));
  const common = [];
  for (let index = 0; index < minDepth - 1; index++) {
    const segment = parts[0][index];
    if (parts.every((segments) => segments[index] === segment)) common.push(segment);
    else break;
  }
  return common.length ? common.join('/') : '.';
}
