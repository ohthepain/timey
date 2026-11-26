(() => {
  'use strict';
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  function fixedModel(model, error) {
    const reason = esc(model.reason);
    const name = esc(model.model || 'Unknown');
    const display = model.reasonInTooltip
      ? `<p>${name} <span data-model-help><button type="button" class="icon-button" aria-label="Repair model information" aria-describedby="block-model-help">ⓘ</button><span id="block-model-help" role="tooltip">${reason}</span></span></p>`
      : `<p>${name}</p><p class="detail-copy">${reason}</p>`;
    return `<section class="detail-section"><div class="section-label">${model.reason.includes('repair') ? 'Repair model' : 'Model'}</div>${display}${error}</section>`;
  }
  window.factoryBlockModel = (model, value) => {
    if (!model || model.kind === 'none') return '';
    const availability =
      model.kind !== 'select' || value === model.selected
        ? model.availability
        : !value
          ? model.defaultAvailability
          : { status: 'available' };
    const blocked = !['available', 'warning', 'unmonitored'].includes(availability.status);
    const error = blocked
      ? `<p class="inline-error" role="alert" data-block-model-error>${esc(availability.reason)}</p>`
      : '';
    if (model.kind === 'fixed') return fixedModel(model, error);
    const choices = model.choices
      .map(
        (entry) =>
          `<option value="${esc(entry.id)}"${value === entry.id ? ' selected' : ''}>${esc(entry.name || entry.id)}</option>`
      )
      .join('');
    const retained =
      value && !model.choices.some((entry) => entry.id === value)
        ? `<option value="${esc(value)}" selected disabled>${esc(value)} · unavailable</option>`
        : '';
    return `<section class="detail-section"><label class="field">Model<select name="model" data-field="model"${model.locked ? ' disabled' : ''}><option value=""${!value ? ' selected' : ''}>Use issue default · ${esc(model.defaultModel)}</option>${choices}${retained}</select></label><p class="detail-copy">Applies to the next attempt. Earlier attempts keep their original model.</p>${error}</section>`;
  };
})();
