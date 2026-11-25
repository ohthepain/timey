(() => {
  function issueGroups(issues) {
    const groups = new Map(issues.map((issue) => [issue.id, { issue, children: [] }]));
    for (const issue of issues) groups.get(issue.masterId)?.children.push(issue);
    return [...groups.values()].filter(({ issue }) => !groups.has(issue.masterId));
  }

  function masterBadge(compact = false) {
    return compact
      ? '<span class="master-badge" data-compact aria-label="Master" title="Master issue">m</span>'
      : '<span class="master-badge">Master</span>';
  }

  window.issueGroupUI = { issueGroups, masterBadge };
})();
