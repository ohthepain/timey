(() => {
  'use strict';
  const guides = {
    codex: 'https://developers.openai.com/codex/cli/',
    anthropic: 'https://code.claude.com/docs/en/setup',
    google: 'https://geminicli.com/docs/get-started/installation/',
  };
  function commandBlock(provider, kind, command, esc) {
    return `<div data-provider-command><code>${esc(command)}</code><button type="button" class="small-button" data-provider-copy="${provider.id}" data-command-kind="${kind}" aria-label="Copy ${kind} command">Copy</button></div>`;
  }
  function setupGuidance(provider, esc) {
    const setup = provider.setup;
    if (provider.ready || !setup) return '';
    const install = ['install', 'installing'].includes(setup.step);
    return `<div data-provider-setup-guide><p>${install ? `Factory needs <strong>${esc(setup.agent)}</strong> on this computer. This installs the agent for your user account, so other projects can use it too.` : `Check the ${esc(setup.agent)} installation and sign-in in Terminal.`}</p>
      ${setup.prerequisite ? `<p>${esc(setup.prerequisite)} <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">Get Node.js</a></p>` : ''}
      <ol>${install ? `<li>Install ${esc(setup.agent)}.${commandBlock(provider, 'install', setup.command, esc)}${setup.canInstall ? '<small>The Install button opens Terminal and runs this exact command.</small>' : '<small>Copy this command into your terminal and wait for installation to finish.</small>'}</li>` : ''}
      <li>Check that it starts.${commandBlock(provider, 'check', setup.checkCommand, esc)}</li>
      <li>Sign in using the native agent.${commandBlock(provider, 'signin', setup.loginCommand, esc)}</li>
      <li>Return here and choose <strong>Check again</strong>. Then enable the models you want and Save.</li></ol>
      <p class="muted">If the command works in your terminal but Factory cannot find it, restart Factory from that terminal so it receives the same PATH.</p></div>`;
  }
  function providerActions(provider) {
    const setup = provider.setup;
    const install = setup?.step === 'install' && setup.canInstall;
    const signIn = !provider.ready && !['install', 'installing'].includes(setup?.step);
    return `<div data-provider-actions>${install ? `<button type="button" class="primary-button" data-provider-action="install" data-provider-id="${provider.id}">Install ${setup.agent}</button>` : ''}${signIn ? `<button type="button" class="primary-button" data-provider-action="setup" data-provider-id="${provider.id}">${{ error: 'Retry setup', signin: 'Sign in' }[setup?.step] || 'Setup'}</button>` : ''}<button type="button" class="small-button" data-provider-action="refresh" data-provider-id="${provider.id}">${provider.ready ? 'Refresh models and quota' : 'Check again'}</button><a href="${guides[provider.id]}" target="_blank" rel="noreferrer">Installation guide</a></div>`;
  }
  function providerConfiguration(provider, esc) {
    return `
          <p>${esc(provider.message)}</p>
          ${providerActions(provider)}
          ${setupGuidance(provider, esc)}
          <p data-provider-result="${provider.id}" role="status"></p>
          ${provider.checkedAt ? `<small class="muted">Last checked ${esc(new Date(provider.checkedAt).toLocaleString())}</small>` : ''}
          ${provider.models.length ? `<div data-provider-models>${provider.models.map((model) => `<label data-provider-model><input type="checkbox" name="enabled:${esc(model.id)}" value="true"${model.enabled ? ' checked' : ''} /><span>${esc(model.name)}<small>${esc(model.id)}</small><small data-model-availability="${esc(model.id)}">${esc(model.availability.reason)}</small></span></label>`).join('')}</div>` : '<p>Models will appear here after installation and sign-in are confirmed.</p>'}
          <div data-provider-thresholds><label class="field">Warn at remaining %<input name="warning:${provider.id}" type="number" min="0" max="100" step="0.1" required value="${provider.warning}" /></label><label class="field">Disable at remaining %<input name="disable:${provider.id}" type="number" min="0" max="100" step="0.1" required value="${provider.disable}" /></label></div>
          <label data-provider-model><input type="checkbox" name="unmonitored:${provider.id}" value="true"${provider.allowUnmonitored ? ' checked' : ''} /><span>Allow work without quota monitoring<small>Unknown or stale allowance otherwise blocks work. Confirmed exhaustion always blocks work.</small></span></label>
`;
  }
  window.factoryProviderSettings = {
    render(data, esc, saveButton) {
      return `<p>Choose models for this Factory installation. Sign-in belongs to each native agent and may be shared with other projects. Setup sends no model prompt.</p><form data-settings-form>${data.providers
        .map(
          (provider) => `
        <fieldset data-provider="${provider.id}"${data.readOnly ? ' disabled' : ''}>
          <legend>${esc(provider.name)}</legend>
          <label class="provider-enable"><input type="checkbox" data-provider-enabled="${provider.id}"${provider.active ? ' checked' : ''} />Enabled</label>
          <div data-provider-configuration="${provider.id}"${provider.active ? '' : ' hidden'}>
            ${providerConfiguration(provider, esc)}
          </div>
        </fieldset>`
        )
        .join(
          ''
        )}<p>Provider changes apply immediately. Save model and quota settings below.</p>${data.readOnly ? '<p>Open the owning Factory server to change these settings.</p>' : saveButton}</form>`;
    },
    input(data, fields) {
      return {
        revision: data.revision,
        providers: Object.fromEntries(
          data.providers.map((provider) => [
            provider.id,
            {
              enabled: provider.models
                .filter((model) => fields['enabled:' + model.id] === 'true')
                .map((model) => model.id),
              warning: Number(fields['warning:' + provider.id]),
              disable: Number(fields['disable:' + provider.id]),
              allowUnmonitored: fields['unmonitored:' + provider.id] === 'true',
            },
          ])
        ),
      };
    },
  };
  let bannerSequence = 0;
  function providerWarning(provider) {
    const reasons = new Set(
      provider.models
        .filter((model) => model.enabled && model.availability.status !== 'available')
        .map((model) => model.availability.reason)
    );
    return reasons.size ? `${provider.name}: ${[...reasons].join(' ')}` : '';
  }
  function renderBanner(providers) {
    const banner = document.getElementById('provider-status-banner');
    if (!banner) return;
    const messages = providers
      .filter((provider) => provider.active)
      .map(providerWarning)
      .filter(Boolean);
    banner.hidden = !messages.length;
    banner.querySelector('[data-provider-status-text]').textContent = messages.join(' · ');
  }
  async function updateBanner() {
    if (!document.getElementById('provider-status-banner') || document.hidden) return;
    const ticket = ++bannerSequence;
    try {
      const response = await fetch('/api/ai-provider-status');
      if (!response.ok) return;
      const data = await response.json();
      if (ticket === bannerSequence) renderBanner(data.providers);
    } catch {
      /* Retain the last observed warning while disconnected. */
    }
  }
  window.addEventListener('factory-provider-settings-saved', (event) => {
    if (!event.detail) return void updateBanner();
    bannerSequence++;
    renderBanner(event.detail);
  });
  setInterval(() => void updateBanner(), 10000);
  void updateBanner();
})();
