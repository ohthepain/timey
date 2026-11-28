function operationIssues(record) {
  if (!record.key.startsWith('operations/') || typeof record.value?.kind !== 'string') return [];
  const input = record.value.input;
  const deleted = Array.isArray(record.value.deletedIssueIds) ? record.value.deletedIssueIds : [];
  return [
    ...new Set(
      [
        input?.issueId,
        input?.id,
        ...(Array.isArray(input?.ids) ? input.ids : []),
        ...(Array.isArray(input?.issueIds) ? input.issueIds : []),
        ...(Array.isArray(record.value.sources)
          ? record.value.sources.flatMap((source) => [source.id, source.issueId])
          : []),
      ].filter((id) => typeof id === 'string' && id.length > 0 && !deleted.includes(id))
    ),
  ];
}

export function ownsDeletedRecord(record, issueId) {
  if (['flows/', 'evidence/', 'classic/', 'catalog/'].some((prefix) => record.key === prefix + issueId)) return true;
  if (
    ['issues/', 'progress/', 'commands/', 'issue-history/', 'issue-annotations/', 'artifact-releases/'].some((prefix) =>
      record.key.startsWith(prefix + issueId + '/')
    )
  )
    return true;
  return operationIssues(record).includes(issueId);
}

export function redactDeletedMove(record, issueId) {
  const value = record.value;
  if (
    !record.key.startsWith('operations/') ||
    value?.kind !== 'move-issue' ||
    value.status !== 'confirmed' ||
    !Array.isArray(value.sources)
  )
    return null;
  const owns = (source) => (source.id || source.issueId) === issueId;
  if (
    !value.sources.some(owns) ||
    !value.sources.some((source) => typeof (source.id || source.issueId) === 'string' && !owns(source))
  )
    return null;
  return {
    ...value,
    sources: value.sources.filter((source) => !owns(source)),
    deletedIssueIds: [...new Set([...(Array.isArray(value.deletedIssueIds) ? value.deletedIssueIds : []), issueId])],
  };
}

function removable(record, issueId, operationKey) {
  if (record.key === operationKey || record.key === 'catalog/' + issueId) return false;
  if (!ownsDeletedRecord(record, issueId)) return false;
  return !record.key.startsWith('operations/') || operationIssues(record).every((id) => id === issueId);
}

function uniqueReferences(refs) {
  return [...new Map(refs.map((ref) => [JSON.stringify([ref.storeId, ref.key, ref.sha256, ref.bytes]), ref])).values()];
}

export function planRetirement(snapshot, issueId, { operationKey } = {}) {
  const owned = (record) => record.key !== operationKey && ownsDeletedRecord(record, issueId);
  const records = snapshot.records.filter((record) => removable(record, issueId, operationKey));
  const receipts = snapshot.receipts.filter((receipt) => receipt.records.some(owned));
  const replaced = snapshot.records
    .filter((record) => record.key !== operationKey)
    .flatMap((record) => {
      const value = redactDeletedMove(record, issueId);
      return value ? [{ record, value }] : [];
    });
  const values = [
    ...records.map((record) => record.value),
    ...replaced.flatMap(({ record }) =>
      record.value.sources.filter((source) => (source.id || source.issueId) === issueId)
    ),
    ...receipts.flatMap((receipt) => receipt.records.filter(owned).map((record) => record.value)),
  ];
  const survivingRefs = receipts.flatMap((receipt) =>
    receipt.records.filter((record) => !owned(record)).flatMap((record) => record.refs)
  );
  return {
    records: records.map(({ key, revision }) => ({ key, revision })),
    replacements: replaced.map(({ record, value }) => ({ key: record.key, revision: record.revision, value })),
    receipts: receipts.map(({ id, inputDigest, identity }) => ({ id, inputDigest, identity })),
    values,
    survivingRefs,
    refs: uniqueReferences(
      [...records, ...receipts, ...replaced.map(({ record }) => record)].flatMap((record) => record.refs || [])
    ),
  };
}
