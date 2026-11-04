/* A projection of existing records and public events; never a workflow record. */
const issueProgressUI = (() => {
  const activeStatuses = new Set(['preparing', 'running', 'checking', 'inProgress']);
  const stoppedStatuses = new Set(['blocked', 'failed', 'attention']);
  const completeStatuses = new Set(['completed', 'handed-off', 'merged', 'finished', 'reconciled']);
  const time = (value) => Date.parse(value || '') || 0;
  function runsFor(issue, data) {
    return (data.runs || [])
      .filter(
        (run) =>
          run.issueId === issue.id || data.actions?.some((a) => a.id === run.actionId && a.issues.includes(issue.id))
      )
      .sort((a, b) => time(a.created) - time(b.created));
  }
  function basis(issue, runs) {
    return JSON.stringify([
      issue.lifecycle?.updated,
      issue.strategy?.runId,
      issue.strategy?.status,
      runs.map((r) => [r.id, r.status, r.updated, r.output]),
    ]);
  }
  function milestones(issue, runs, data) {
    const entries = [];
    if (issue.created) entries.push('Issue captured');
    if (issue.lifecycle?.approval) entries.push('Plan approved');
    if (runs.some((r) => r.kind === 'issue-work')) entries.push('Issue work started');
    const latest = runs.findLast((r) => r.kind === 'issue-work');
    for (const run of runs.filter((r) => r.result?.checked?.head)) {
      entries.push(
        run === latest && (!issue.workingGit?.revision || issue.workingGit.revision === run.result.checked.head)
          ? 'Checks passed for the recorded candidate'
          : 'Checks passed on an earlier attempt (superseded)'
      );
    }
    for (const event of issue.lifecycle_history || []) {
      const name = data.lifecycle?.find((stage) => stage.state === event.state)?.name;
      if (event.outcome === 'completed' && name) entries.push(`${name} completed (earlier work)`);
    }
    return [...new Set(entries)];
  }
  function interview(conversation) {
    const messages = conversation?.messages || [];
    const start = messages.findLastIndex(
      (m) =>
        m.actor === 'human' &&
        (m.id?.startsWith('capture-grill-') || m.skills?.some((s) => (s.name || s) === 'grilling'))
    );
    if (start < 0) return null;
    const latest = messages
      .slice(start)
      .filter((m) => ['human', 'agent'].includes(m.actor))
      .at(-1);
    // Retain the actual round verbatim; do not invent questions or infer approval.
    return latest?.kind === 'reply' && /(?:❓|\bQ\d+\b|\?)/u.test(latest.body) ? latest : null;
  }
  function currentCommand(run) {
    return selectCommand(run?.output || [], stoppedStatuses.has(run?.status));
  }
  function selectCommand(output, stopped) {
    const commands = output.filter((entry) => entry.kind === 'command');
    return stopped
      ? commands.findLast(commandFailed) || null
      : commands.findLast((entry) => activeStatuses.has(entry.status)) || commands.at(-1);
  }
  function commandFailed(entry) {
    return ['failed', 'error'].includes(entry.status) || (entry.exitCode !== undefined && entry.exitCode !== 0);
  }
  function commandPurpose(command) {
    const value = String(command || '').replace(/^(?:[A-Z][A-Z0-9_]*=\S+\s+)+/, '');
    const purposes = [
      [/\bpnpm\s+run\s+test:factory\b/, 'Runs the automated checks for the factory and issue workflows.'],
      [/\bpnpm\s+run\s+test:browser\b/, 'Runs browser checks for the app and factory screens.'],
      [/\bpnpm\s+run\s+audit:step\b/, 'Checks changed code against the project’s design and maintainability rules.'],
      [
        /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:verify|test(?::[\w-]+)?|typecheck|build)\b/,
        'Runs the project’s automated checks for the requested task.',
      ],
      [/\bgit\s+fetch\b/, 'Downloads updates from the named remote repository.'],
      [/\bgit\s+merge\b/, 'Combines the named branch with the current branch.'],
    ];
    return purposes.find(([pattern]) => pattern.test(value))?.[1] || 'The command’s purpose was not recorded.';
  }
  function failedCommandDetails(command) {
    const result = command.exitCode === undefined ? 'a reported error' : `failure code ${command.exitCode}`;
    return {
      step: 'Command failed',
      explanation: `${commandPurpose(command.command)} It stopped with ${result}.`,
      next: 'Review the command output, fix the reported problem, then continue.',
      diagnostics: command.text || null,
    };
  }
  function formatPR(number) {
    return Number.isSafeInteger(number) ? `PR #${number}` : 'no PR number';
  }
  function pullRequestCheckDetails(issue, run, reason) {
    const reported = run.result.pr;
    const saved = issue.strategy.pr;
    if (reported === saved) return null;
    return {
      step: 'Checking pull request details',
      explanation: `The factory check stopped because the work response named ${formatPR(reported)}, while this issue has ${formatPR(saved)} saved. This does not show who created that PR or whether it belongs to this issue.`,
      next: 'Check the issue branch and matching pull request to confirm what is already published, then continue with the correct record.',
      commandNotice: 'No failed shell command was recorded.',
      diagnostics: `Factory check: ${reason}\nWork response: ${formatPR(reported)}
Saved issue record: ${formatPR(saved)}`,
    };
  }
  function internalCheckDetails(reason) {
    return {
      step: 'Factory check stopped',
      explanation: 'The factory stopped work during an internal check. No failed shell command was recorded.',
      next: 'Check the issue, branch, and pull request records for the cause before retrying.',
      commandNotice: 'No failed shell command was recorded.',
      diagnostics: reason || null,
    };
  }
  function publicationFailureDetails(issue, run, reason) {
    return reason.includes('server owns PR publication') ? pullRequestCheckDetails(issue, run, reason) : null;
  }
  function stopReason(run) {
    return run.displaySummary || run.summary || '';
  }
  function noCommandFailureDetails(issue, run) {
    const reason = stopReason(run);
    return publicationFailureDetails(issue, run, reason) || internalCheckDetails(reason);
  }
  function stoppedFailureDetails(issue, run) {
    const command = currentCommand(run);
    return command ? failedCommandDetails(command) : noCommandFailureDetails(issue, run);
  }
  function stoppedDetails(issue, run, status) {
    return stoppedStatuses.has(status) ? stoppedFailureDetails(issue, run) : {};
  }
  function pendingInput(issue, run, conversation) {
    if (issue.lifecycle?.status === 'answering')
      return {
        status: 'running',
        step: 'Saving your answer',
        explanation: 'Your answer is being recorded by the current operation.',
        next: 'Wait for the updated request or progress.',
      };
    const input = issue.lifecycle?.input;
    const approvals = run?.connected ? run.approvals || [] : [];
    if (input && input.type !== 'retry') {
      const questions = ['questions', 'scope', 'worker', 'human', 'delivery-setup'].includes(input.type);
      return {
        status: 'waiting for you',
        step: questions ? 'Answering scope questions' : 'Waiting for approval',
        explanation: questions
          ? 'The issue assistant is waiting for your answers before dependent work can continue.'
          : issue.lifecycle.summary || 'Review the pending request before work continues.',
        next: questions ? 'Answer the questions below.' : 'Review the request below.',
      };
    }
    if (approvals.length)
      return {
        status: 'waiting for you',
        step: 'Waiting for permission or input',
        explanation: 'The active worker needs your response to continue.',
        next: 'Respond to the request below.',
      };
    if (!run?.connected && !issue.strategy?.active && !conversation?.connected && interview(conversation))
      return {
        status: 'waiting for you',
        step: 'Answering scope questions',
        explanation: 'The issue assistant is waiting for your answers. This interview does not start implementation.',
        next: 'Answer the grilling questions below.',
      };
    return null;
  }
  function operationState(issue, run, conversation) {
    const strategy = issue.strategy || {};
    const record = issue.lifecycle || {};
    const running =
      run?.connected ||
      strategy.active ||
      ['running', 'answering'].includes(record.status) ||
      (conversation?.connected && conversation.issueId === issue.id);
    if (running) {
      const command = currentCommand(run);
      const checking =
        run?.status === 'checking' ||
        (activeStatuses.has(command?.status) &&
          /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w-]+)?|verify|audit:[\w-]+|typecheck|build)\b/.test(
            command?.command || ''
          ));
      return {
        status: 'running',
        step: checking
          ? 'Running verification'
          : conversation?.connected && !run?.connected && !strategy.active
            ? 'Issue assistant responding'
            : 'Working on the issue',
        explanation: checking
          ? 'Checking the current candidate. Individual checks appear when the output identifies them.'
          : run?.summary || record.summary || 'The issue assistant is working in the owning conversation.',
        next: 'Wait for the current operation to finish.',
      };
    }
    const newerRun =
      run?.id !== strategy.runId &&
      run?.id !== record.work?.runId &&
      time(run?.updated || run?.created) > time(record.updated);
    const status = newerRun
      ? run?.status
      : strategy.status === 'queued'
        ? record.status || run?.status
        : strategy.status || record.status || run?.status;
    const explanation = newerRun ? run?.summary : record.summary || run?.summary;
    if (completeStatuses.has(status)) {
      const step =
        status === 'merged'
          ? 'Full Send complete; PR merged'
          : status === 'handed-off' && record.work
            ? strategy.strategy === 'full-send'
              ? 'Review complete; PR ready for review'
              : 'Full Stop complete; PR ready for review'
            : record.deliveryHandoff
              ? 'Draft PR handoff complete'
              : 'Operation complete';
      return {
        status: 'complete',
        step,
        explanation: explanation || 'The selected operation has finished.',
        next: 'Review the result. Issue acceptance remains separate.',
      };
    }
    if (['failed', 'attention'].includes(status) || conversation?.status === 'attention')
      return {
        status: 'failed',
        step: 'Operation failed',
        explanation: explanation || 'The operation stopped with an error. Inspect Issue output.',
        next: 'Inspect the failure, then Continue when ready.',
        ...stoppedDetails(issue, run, status),
      };
    if (['blocked', 'paused', 'stopped'].includes(status))
      return {
        status: 'blocked',
        step: status === 'paused' ? 'Work paused' : 'Work blocked',
        explanation: explanation || 'The operation stopped and needs attention.',
        next: 'Resolve the stop reason, then Continue when ready.',
        ...stoppedDetails(issue, run, status),
      };
    if (!run && !issue.lifecycle && !conversation?.messages?.length)
      return {
        status: 'not started',
        step: 'Not started',
        explanation: 'No operation has started for this issue.',
        next: 'Choose a strategy and Continue when ready.',
      };
    return {
      status: 'progress unavailable',
      step: 'Progress unavailable',
      explanation: 'Current activity is not confirmed. Saved output remains available.',
      next: 'Refresh to check the connection before continuing.',
    };
  }
  function derive(issue, data, feedback, unavailable = false) {
    const runs = runsFor(issue, data);
    const run =
      runs.findLast((r) => r.connected && r.approvals?.length) || runs.findLast((r) => r.connected) || runs.at(-1);
    const conversation = data.conversation?.issueId === issue.id ? data.conversation : null;
    const lastUpdate = [
      issue.lifecycle?.updated,
      run?.health?.lastActivityAt,
      run?.output?.at(-1)?.at,
      run?.updated,
      run?.created,
      issue.updated,
    ]
      .filter(Boolean)
      .sort((a, b) => time(a) - time(b))
      .at(-1);
    const base = {
      milestones: milestones(issue, runs, data),
      lastUpdate,
      command: currentCommand(run),
      running:
        runs.some((r) => r.connected) ||
        Boolean(issue.strategy?.active) ||
        ['running', 'answering'].includes(issue.lifecycle?.status),
      interview: interview(conversation),
    };
    if (feedback)
      return {
        ...base,
        status: feedback.error ? 'failed' : 'running',
        step: feedback.error ? 'Continue needs attention' : 'Request sent; waiting for updated progress',
        explanation: feedback.message,
        next: feedback.error ? 'Refresh to check progress before retrying.' : 'Wait for updated progress.',
        command: null,
        interview: null,
      };
    if (unavailable)
      return {
        ...base,
        status: 'progress unavailable',
        step: 'Progress unavailable',
        explanation: 'The connection needs attention. This is the last known information.',
        next: 'Refresh to reconnect.',
        command: null,
      };
    return { ...base, ...(pendingInput(issue, run, conversation) || operationState(issue, run, conversation)) };
  }
  return { derive, runsFor, basis, purpose: commandPurpose };
})();
