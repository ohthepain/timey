(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const busy = (session) => ['running', 'starting', 'stopping'].includes(session?.status);
  window.createProjectHomeUI = ({ request, post, navigateHome, changed }) => {
    const discuss = window.createProjectDiscussUI({ request, post });
    window.createProjectAdminUI({ request, post });
    const tabs = document.querySelectorAll('[role="tab"][data-project-tab]');
    const requestedTab = new URL(location.href).searchParams.get('projectTab');
    let projectTab = ['issues', 'discuss', 'admin'].includes(requestedTab) ? requestedTab : 'home';
    const state = {
      visible: false,
      data: null,
      loading: false,
      pending: false,
      investigation: null,
      automate: null,
      draftBasis: null,
      submissions: new Map(),
    };

    function loadIssuesFrame() {
      if (!state.visible || projectTab !== 'issues') return;
      const frame = document.querySelector('#project-issues iframe');
      if (frame && !frame.hasAttribute('src')) frame.src = frame.dataset.src;
    }

    function selectProjectTab(tab) {
      projectTab = tab;
      const url = new URL(location.href);
      if (tab !== 'home') url.searchParams.set('projectTab', tab);
      else url.searchParams.delete('projectTab');
      history.replaceState(null, '', url);
      $('project-home').dataset.projectTab = tab;
      document.querySelector('.workspace').dataset.projectHomeTab = tab;
      document.querySelector('.flow-footer')?.classList.toggle('discuss-hidden', tab === 'discuss');
      $('project-home-content').hidden = tab !== 'home';
      $('project-issues').hidden = tab !== 'issues';
      $('project-admin').hidden = tab !== 'admin';
      for (const button of tabs) button.setAttribute('aria-selected', String(button.dataset.projectTab === tab));
      discuss.setVisible(state.visible && tab === 'discuss');
      loadIssuesFrame();
    }
    for (const button of tabs) button.addEventListener('click', () => selectProjectTab(button.dataset.projectTab));
    selectProjectTab(projectTab);

    function syncIssueDetailWidth() {
      const frame = document.querySelector('#project-issues iframe');
      const workspace = document.querySelector('.workspace');
      if (!frame?.contentDocument || !workspace) return;
      const configuredWidth = getComputedStyle(workspace).getPropertyValue('--inspector-width').trim();
      const responsiveWidth = window.innerWidth <= 1180 ? '335px' : window.innerWidth >= 1650 ? '435px' : '390px';
      frame.contentDocument.documentElement.style.setProperty(
        '--project-issue-detail-width',
        localStorage.getItem('factory.project-issues.detail-width') || configuredWidth || responsiveWidth
      );
    }
    const issuesFrame = document.querySelector('#project-issues iframe');
    issuesFrame?.addEventListener('load', syncIssueDetailWidth);
    syncIssueDetailWidth();
    window.addEventListener('resize', syncIssueDetailWidth);
    const workspace = document.querySelector('.workspace');
    if (workspace && window.MutationObserver) {
      new MutationObserver(syncIssueDetailWidth).observe(workspace, {
        attributes: true,
        attributeFilter: ['style'],
      });
    }

    function investigationSessions() {
      return state.data?.investigations || [];
    }
    function automateSessions() {
      return state.data?.automateMe?.sessions || [];
    }

    async function refresh() {
      if (state.loading) return;
      state.loading = true;
      try {
        state.data = await request('/api/project-home');
        $('home-error').textContent = '';
        renderHome();
        updateSelected('automate', automateSessions());
      } catch (error) {
        $('home-error').textContent = error.message;
      } finally {
        state.loading = false;
      }
    }

    function updateSelected(kind, sessions) {
      if (!state[kind]) return;
      const session = sessions.find(({ id }) => id === state[kind].id);
      if (session) state[kind] = session;
      renderSelected(kind);
    }

    function runTitle(session, kind) {
      if (kind === 'investigation') return session.focus;
      return session.draft?.name || 'Working-style skill';
    }
    function runStamp(session) {
      return session.startingPoint?.name || session.updatedAt || session.createdAt;
    }
    function renderRuns(id, sessions, kind) {
      const markup = sessions
        .map(
          (session) =>
            `<button class="home-run" type="button" data-home-session="${kind}" data-session-id="${escape(session.id)}"><span><strong>${escape(runTitle(session, kind))}</strong><small>${escape(runStamp(session))}</small></span><span data-run-status>${escape(session.status)}</span></button>`
        )
        .join('');
      const content = markup || '<p class="muted">No saved sessions yet.</p>';
      if ($(id).innerHTML !== content) $(id).innerHTML = content;
    }
    function renderHome() {
      const { project, stats } = state.data;
      $('home-title').textContent = project.name;
      $('home-created').textContent = stats.created;
      $('home-closed').textContent = stats.closed;
      $('home-window').textContent = 'Through ' + new Date(stats.windowEnd).toLocaleString();
      $('home-stats-note').textContent = stats.incompleteHistory
        ? 'Includes archived issues. Older closure history is incomplete; shown counts include known closures.'
        : 'Includes archived issues. Each issue closed during the period counts once, including reopened issues.';
      renderRuns('home-investigations', investigationSessions(), 'investigation');
      renderRuns('home-automate-sessions', automateSessions(), 'automate');
    }

    function options(id, entries, value) {
      $(id).innerHTML = entries
        .map(({ value: key, label }) => `<option value="${escape(key)}">${escape(label)}</option>`)
        .join('');
      if (!entries.some((entry) => entry.value === value)) {
        $(id).insertAdjacentHTML(
          'afterbegin',
          '<option value="" disabled selected>Choose an available option</option>'
        );
      }
      $(id).value = value || '';
    }

    async function openInvestigation(session) {
      await refresh();
      if (!state.data) throw new Error('Project settings could not be loaded. Refresh and try again.');
      const current = {
        requestId: crypto.randomUUID(),
        status: 'draft',
        messages: [],
        focus: 'Whole codebase',
        branch: state.data.defaultBranch,
        folder: state.data.defaultFolder,
        instructions: '',
        ...session,
      };
      state.investigation = current;
      configureInvestigation(current);
      $('home-investigation-error').textContent = '';
      $('home-investigation-dialog').showModal();
    }
    function configureInvestigation(current) {
      options(
        'home-investigation-branch',
        state.data.branches.map(({ ref, name }) => ({ value: ref, label: name })),
        current.branch
      );
      options(
        'home-investigation-folder',
        state.data.folders.map(({ name }) => ({ value: name, label: name })),
        current.folder
      );
      options(
        'home-investigation-focus',
        state.data.focuses.map((value) => ({ value, label: value })),
        current.focus
      );
      $('home-investigation-prompt').value = current.prompt ?? state.data.prompts[current.focus];
      $('home-investigation-instructions').value = current.instructions;
      $('home-investigation-reusable').checked = false;
    }

    function renderMessages(id, messages) {
      const markup = (messages || [])
        .map(
          ({ role, text, content }) =>
            `<article data-home-message><strong>${role === 'user' ? 'You' : 'Assistant'}</strong><div>${escape(text || content)}</div></article>`
        )
        .join('');
      if ($(id).innerHTML !== markup) {
        $(id).innerHTML = markup;
        $(id).scrollTop = $(id).scrollHeight;
      }
    }

    function operationStatus(kind, session) {
      $(`home-${kind}-status`).textContent = session.status === 'draft' ? '' : session.phase || session.status;
      if (session.error) $(`home-${kind}-error`).textContent = session.error;
    }
    function setRunButtons(kind, session) {
      const dialog = $('home-' + kind + '-dialog');
      dialog.querySelector(`[data-home-command="${kind}-stop"]`).hidden = !busy(session);
      dialog.querySelector(`[data-home-command="${kind}-retry"]`).hidden = ![
        'failed',
        'stopped',
        'interrupted',
      ].includes(session.status);
      operationStatus(kind, session);
    }
    async function openAutomate(session) {
      await refresh();
      state.automate = session || {
        requestId: crypto.randomUUID(),
        status: 'draft',
        durationValue: 4,
        durationUnit: 'weeks',
        destination: 'project',
        messages: [],
      };
      const current = state.automate;
      $('home-automate-duration').value = current.durationValue;
      $('home-automate-unit').value = current.durationUnit;
      $('home-automate-destination').value = current.destination;
      $('home-automate-message').value = '';
      $('home-automate-activate').checked = false;
      $('home-automate-error').textContent = '';
      renderAutomate(true);
      $('home-automate-dialog').showModal();
    }

    function automateReplyControls(session) {
      const hasSession = Boolean(session.id);
      $('home-automate-start').hidden = hasSession;
      $('home-automate-reply').hidden = !hasSession || session.status === 'applied';
      $('home-automate-reply').querySelector('button').disabled = busy(session) || state.pending;
      for (const id of ['home-automate-duration', 'home-automate-unit']) $(id).disabled = hasSession;
    }
    function coverageText(history) {
      if (!history) return '';
      const suffix = history.truncated ? ' Some history was truncated.' : '';
      return `${history.messageCount} messages from ${history.threadCount} conversations. ${history.gaps.join(' ')}${suffix}`;
    }
    function automateReviewControls(session) {
      const disabled = [busy(session), state.pending, session.status === 'applied'].some(Boolean);
      $('home-automate-preview').disabled = disabled;
      $('home-automate-apply').disabled = disabled || !state.draftBasis;
      for (const id of ['home-automate-content', 'home-automate-name']) $(id).disabled = disabled;
    }
    function renderAutomate(fillDraft = false) {
      const session = state.automate;
      setRunButtons('automate', session);
      renderMessages('home-automate-messages', session.messages);
      automateReplyControls(session);
      $('home-automate-coverage').textContent = coverageText(session.history);
      $('home-automate-review').hidden = !session.draft;
      fillAutomateDraft(session, fillDraft);
      automateReviewControls(session);
    }
    function fillAutomateDraft(session, force) {
      if (!session.draft) return;
      const fingerprint = JSON.stringify([session.id, session.draft.content, session.draft.basis]);
      if (!force && $('home-automate-review').dataset.draft === fingerprint) return;
      $('home-automate-review').dataset.draft = fingerprint;
      writeAutomateDraft(session.draft);
    }
    function writeAutomateDraft(draft) {
      $('home-automate-name').value = draft.name;
      $('home-automate-content').value = draft.content;
      $('home-automate-current').value = draft.currentContent || 'No existing skill at this destination.';
      $('home-automate-path').textContent = draft.path;
      $('home-automate-destination').value = draft.destination;
      state.draftBasis = draft.basis;
    }

    function investigationInput() {
      return {
        id: state.investigation?.id,
        requestId: state.investigation?.requestId,
        focus: $('home-investigation-focus').value,
        branch: $('home-investigation-branch').value,
        prompt: $('home-investigation-prompt').value,
        instructions: $('home-investigation-instructions').value,
        issueFolder: $('home-investigation-folder').value,
        reusable: $('home-investigation-reusable').checked,
      };
    }

    function automateDraftInput() {
      return {
        id: state.automate?.id,
        name: $('home-automate-name').value,
        content: $('home-automate-content').value,
        destination: $('home-automate-destination').value,
        basis: state.draftBasis,
        activate: $('home-automate-activate').checked,
      };
    }

    function renderSelected(kind) {
      if (kind === 'automate') renderAutomate();
    }

    function stableSubmission(action, input) {
      const key = JSON.stringify([action, input]);
      if (!state.submissions.has(key)) state.submissions.set(key, input.requestId || crypto.randomUUID());
      return { key, value: { action, ...input, requestId: state.submissions.get(key) } };
    }

    async function send(kind, action, input) {
      if (state.pending) return;
      state.pending = true;
      const submission = stableSubmission(action, input);
      $(`home-${kind}-error`).textContent = '';
      try {
        const result = await post('project-home-action', submission.value);
        state.submissions.delete(submission.key);
        state[kind] = result.session;
        renderSelected(kind);
        changed();
        await refresh();
        return true;
      } catch (error) {
        $(`home-${kind}-error`).textContent = error.message;
        return false;
      } finally {
        state.pending = false;
        renderSelected(kind);
      }
    }

    async function command(name) {
      const kind = name.startsWith('automate') ? 'automate' : 'investigation';
      const isDraft = ['automate-apply', 'automate-preview'].includes(name);
      return send(kind, name, isDraft ? automateDraftInput() : { id: state[kind].id });
    }
    function openDialog(kind, session) {
      const task = kind === 'investigation' ? openInvestigation(session) : openAutomate(session);
      void task.catch((error) => {
        $('home-error').textContent = error.message;
      });
    }
    function projectNavigation(button) {
      const route = button.dataset.projectHome;
      if (route === 'home' || route === 'discuss') {
        navigateHome();
        selectProjectTab(route);
        void refresh();
        return;
      }
      openDialog(route === 'automate' ? 'automate' : 'investigation');
    }
    function savedNavigation(button) {
      const kind = button.dataset.homeSession;
      if (kind === 'investigation') {
        location.href = '/?issue=' + encodeURIComponent(button.dataset.sessionId);
        return;
      }
      const sessions = automateSessions();
      openDialog(
        kind,
        sessions.find(({ id }) => id === button.dataset.sessionId)
      );
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest(
        '[data-project-home], [data-home-session], [data-home-close], [data-home-command]'
      );
      if (!button) return;
      if (button.dataset.projectHome) return projectNavigation(button);
      if (button.dataset.homeSession) return savedNavigation(button);
      dispatchDialogButton(button);
    });
    function dispatchDialogButton(button) {
      if (button.dataset.homeClose) return $(`home-${button.dataset.homeClose}-dialog`).close();
      void command(button.dataset.homeCommand);
    }

    async function createInvestigation() {
      if (state.pending) return;
      state.pending = true;
      $('home-investigation-run').disabled = true;
      try {
        const result = await post('project-home-action', { action: 'investigation-create', ...investigationInput() });
        location.href = '/?issue=' + encodeURIComponent(result.issueId);
      } catch (error) {
        $('home-investigation-error').textContent = error.message;
      } finally {
        state.pending = false;
        $('home-investigation-run').disabled = false;
      }
    }
    $('home-investigation-focus').addEventListener('change', () => {
      $('home-investigation-prompt').value = state.data.prompts[$('home-investigation-focus').value];
    });
    $('home-investigation-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void createInvestigation();
    });
    $('home-automate-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void send('automate', 'automate-start', {
        requestId: state.automate?.requestId,
        durationValue: Number($('home-automate-duration').value),
        durationUnit: $('home-automate-unit').value,
        destination: $('home-automate-destination').value,
      });
    });
    $('home-automate-reply').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (
        await send('automate', 'automate-message', { id: state.automate.id, message: $('home-automate-message').value })
      )
        $('home-automate-message').value = '';
    });
    for (const id of ['home-automate-name', 'home-automate-content', 'home-automate-destination'])
      $(id).addEventListener('input', () => {
        state.draftBasis = null;
        $('home-automate-apply').disabled = true;
      });
    setInterval(() => {
      if (document.hidden) return;
      if ([state.visible, $('home-investigation-dialog').open, $('home-automate-dialog').open].some(Boolean))
        void refresh();
    }, 2000);
    return {
      setVisible(value) {
        const wasVisible = state.visible;
        state.visible = value;
        $('project-home').hidden = !value;
        discuss.setVisible(value && projectTab === 'discuss');
        loadIssuesFrame();
        if (value && !wasVisible) void refresh();
      },
      openIssuesTab() {
        navigateHome();
        selectProjectTab('issues');
      },
      refresh,
    };
  };
})();
