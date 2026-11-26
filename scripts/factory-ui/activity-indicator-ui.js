(() => {
  'use strict';

  function markup(active) {
    return active
      ? '<span class="activity-indicator" data-view-key="activity-indicator" role="status"><span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="activity-label">Working</span></span>'
      : '';
  }

  function sync(container, active) {
    const indicator = container.querySelector(':scope > .activity-indicator');
    if (!active) indicator?.remove();
    else if (!indicator) container.insertAdjacentHTML('beforeend', markup(true));
  }

  window.timeyActivity = { markup, sync };

  function commandMarkup(command) {
    const escape = window.timeyEscapeHTML;
    const exit = command.exitCode == null ? '' : `<small>Exit code ${escape(command.exitCode)}</small>`;
    return `<li><code>${escape(command.command)}</code>${exit}${command.output ? `<pre>${escape(command.output)}</pre>` : ''}</li>`;
  }

  function commands(entries = [], key) {
    if (!entries.length) return '';
    const count = entries.length;
    return `<details data-chat-commands class="chat-commands discuss-tool-activity" data-view-key="${window.timeyEscapeHTML(key)}"><summary>${count} ${count === 1 ? 'command' : 'commands'}</summary><ol>${entries.map(commandMarkup).join('')}</ol></details>`;
  }

  function milestones(progress, key) {
    const escape = window.timeyEscapeHTML;
    return (progress?.milestones || [])
      .map((entry) => {
        const name = key + '-' + entry.id;
        const role = entry.kind === 'blocked' ? ' role="alert"' : '';
        return `<div data-chat-milestone class="chat-milestone" data-view-key="${escape(name)}"${role}><p>${escape(entry.text)}</p>${commands(entry.commands, name)}</div>`;
      })
      .join('');
  }

  function sparkleText({ label = 'Working', text }) {
    const status = [label, text].filter(Boolean).join(' · ');
    return `<span data-sparkle-text class="SparkleText" role="status">${window.timeyEscapeHTML(status)}</span>`;
  }

  function live(progress = {}, working = true) {
    const { commands: entries = [] } = progress;
    if (!working && !entries.length) return '';
    return `<div data-chat-live class="chat-live activity-indicator" data-view-key="chat-live">${working ? sparkleText(progress) : ''}${liveCommands(entries)}</div>`;
  }

  function liveCommands(entries) {
    return commands(entries, 'live-commands-' + entries.at(0)?.id);
  }

  window.timeyChatProgress = { commands, milestones, live };
})();
