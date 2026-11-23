(() => {
  'use strict';
  const guides = {
    codex: 'https://developers.openai.com/codex/cli/',
    anthropic: 'https://code.claude.com/docs/en/setup',
    google: 'https://geminicli.com/docs/get-started/installation/',
  };
  window.factoryProviderSettings = {
    render(data, esc, saveButton) {
      return `<p>Choose models for this Factory installation. Sign-in belongs to each native agent and may be shared with other projects. Setup sends no model prompt.</p><form data-settings-form>${data.providers
        .map(
          (provider) => `
        <fieldset class="provider-card" data-provider="${provider.id}"${data.readOnly ? ' disabled' : ''}>
          <legend>${esc(provider.name)}</legend>
          <p>${esc(provider.message)}</p>
          <div class="provider-actions">${!provider.ready ? `<button type="button" class="primary-button" data-provider-action="setup" data-provider-id="${provider.id}">Setup</button>` : ''}<button type="button" class="small-button" data-provider-action="refresh" data-provider-id="${provider.id}">Refresh models and quota</button><a href="${guides[provider.id]}" target="_blank" rel="noreferrer">Installation guide</a></div>
          <p data-provider-result="${provider.id}" role="status"></p>
          ${provider.checkedAt ? `<small class="muted">Last checked ${esc(new Date(provider.checkedAt).toLocaleString())}</small>` : ''}
          ${provider.models.length ? `<div class="provider-models">${provider.models.map((model) => `<label class="provider-model"><input type="checkbox" name="enabled:${esc(model.id)}" value="true"${model.enabled ? ' checked' : ''} /><span>${esc(model.name)}<small>${esc(model.id)}</small><small>${esc(model.availability.reason)}</small></span></label>`).join('')}</div>` : '<p>No models discovered. Complete Setup, then Refresh.</p>'}
          <div class="provider-thresholds"><label class="field">Warn at remaining %<input name="warning:${provider.id}" type="number" min="0" max="100" step="0.1" required value="${provider.warning}" /></label><label class="field">Disable at remaining %<input name="disable:${provider.id}" type="number" min="0" max="100" step="0.1" required value="${provider.disable}" /></label></div>
          <label class="provider-model"><input type="checkbox" name="unmonitored:${provider.id}" value="true"${provider.allowUnmonitored ? ' checked' : ''} /><span>Allow work without quota monitoring<small>Unknown or stale allowance otherwise blocks work. Confirmed exhaustion always blocks work.</small></span></label>
        </fieldset>`
        )
        .join(
          ''
        )}<p>Saving disablement stops affected work. Quota recovery restores availability; interrupted work needs Resume.</p>${data.readOnly ? '<p>Open the owning Factory server to change these settings.</p>' : saveButton}</form>`;
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
  document.querySelector('[data-provider-settings-open]')?.addEventListener('click', () => {
    const settings = document.getElementById('project-settings');
    if (!settings) {
      location.href = '/?settings=providers';
      return;
    }
    settings.click();
    document.querySelector('[data-settings-page="providers"]')?.click();
  });
  async function updateBanner() {
    const banner = document.getElementById('provider-status-banner');
    if (!banner || document.hidden) return;
    try {
      const response = await fetch('/api/ai-provider-status');
      if (!response.ok) return;
      const data = await response.json();
      const messages = [];
      for (const provider of data.providers) {
        const reasons = new Set(
          provider.models
            .filter((model) => model.enabled && model.availability.status !== 'available')
            .map((model) => model.availability.reason)
        );
        if (reasons.size) messages.push(`${provider.name}: ${[...reasons].join(' ')}`);
      }
      banner.hidden = !messages.length;
      banner.querySelector('[data-provider-status-text]').textContent = messages.join(' · ');
    } catch {
      /* Retain the last observed warning while disconnected. */
    }
  }
  window.addEventListener('factory-provider-settings-saved', () => void updateBanner());
  setInterval(() => void updateBanner(), 10000);
  void updateBanner();
})();
