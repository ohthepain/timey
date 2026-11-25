(() => {
  const badgeLabels = {
    blocked: 'Blocked',
    'not-ready': 'Not ready',
    'needs-approval': 'Needs approval',
    'needs-git-approval': 'Needs Git approval',
    'master-issue': 'Master issue',
    'sub-issue': 'Sub-issue',
    empty: 'Empty',
    'removed-from-master': 'Removed from master',
  };
  const attention = [new Set(['blocked']), new Set(['not-ready']), new Set(['needs-approval', 'needs-git-approval'])];

  function issueGroups(issues, attentionFirst = false) {
    const groups = new Map(issues.map((issue) => [issue.id, { issue, children: [] }]));
    for (const issue of issues) groups.get(issue.masterId)?.children.push(issue);
    const roots = [...groups.values()].filter(({ issue }) => !groups.has(issue.masterId));
    if (!attentionFirst) return roots;
    for (const group of roots) {
      group.children.sort((left, right) => attentionRank([left]) - attentionRank([right]));
    }
    return roots
      .map((group) => ({ ...group, rank: attentionRank([group.issue, ...group.children]) }))
      .sort((left, right) => left.rank - right.rank);
  }

  function attentionRank(issues) {
    const rank = attention.findIndex((labels) =>
      issues.some((issue) => issue.badges?.some((label) => labels.has(label)))
    );
    return rank === -1 ? attention.length : rank;
  }

  function masterBadge(compact = false) {
    return compact
      ? '<span class="master-badge" data-issue-badge="master-issue" data-compact aria-label="Master" title="Master issue">m</span>'
      : '<span class="master-badge" data-issue-badge="master-issue" title="Master issue">Master</span>';
  }

  function badgeMarkup(badge, compact) {
    if (!Object.hasOwn(badgeLabels, badge)) return '';
    if (badge === 'master-issue') return masterBadge(compact);
    return `<span class="issue-badge" data-issue-badge="${badge}">${badgeLabels[badge]}</span>`;
  }

  function issueBadges({ badges, isMaster } = {}, compact = false) {
    const labels = badges ?? (isMaster ? ['master-issue'] : []);
    return [...new Set(labels)].map((badge) => badgeMarkup(badge, compact)).join(' ');
  }

  function badgeControls(badge = '', attentionFirst = false) {
    const options = Object.entries(badgeLabels)
      .map(([value, name]) => `<option value="${value}"${badge === value ? ' selected' : ''}>${name}</option>`)
      .join('');
    return `<div class="issue-badge-controls"><label>Badge <select aria-label="Filter by badge" data-issue-badge-filter><option value="">All badges</option>${options}</select></label><label><input type="checkbox" data-issue-attention-first${attentionFirst ? ' checked' : ''}> Attention first</label></div>`;
  }

  window.issueGroupUI = { issueGroups, issueBadges, badgeLabels, badgeControls };
})();
