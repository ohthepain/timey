(() => {
  'use strict';
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  function fixedModel(model) {
    const reason = esc(model.reason);
    const name = esc(model.model || 'Unknown');
    return model.reasonInTooltip
      ? `<span>${name} <span data-model-help><button type="button" class="icon-button" aria-label="Repair model information" aria-describedby="block-model-help">ⓘ</button><span id="block-model-help" role="tooltip">${reason}</span></span></span>`
      : `<span>${name}</span>`;
  }
  function modelOptions(model, value, selected) {
    const choices = model.choices
      .map(
        (entry) =>
          `<option value="${esc(entry.id)}"${value === entry.id ? ' selected' : ''}>${esc(entry.name || entry.id)}</option>`
      )
      .join('');
    const retained =
      value && !selected ? `<option value="${esc(value)}" selected disabled>${esc(value)} · unavailable</option>` : '';
    return choices + retained;
  }

  function displayName(selected, value, defaultName) {
    if (selected) return esc(selected.name || selected.id);
    return esc(value || defaultName);
  }

  function defaultOption(model, name) {
    return `<option value="">${esc(model.defaultLabel ?? 'Use issue default')} · ${esc(name)}</option>`;
  }

  function modelPicker(model, value) {
    const selected = model.choices.find((entry) => entry.id === value);
    const defaultName = model.defaultModel ?? 'Unknown';
    const name = displayName(selected, value, defaultName);
    const options = defaultOption(model, defaultName) + modelOptions(model, value, selected);
    return `<span data-block-model-picker><span aria-hidden="true">${name}</span><select name="model" data-field="model" aria-label="Choose model" aria-describedby="block-model-note"${model.locked ? ' disabled' : ''}>${options}</select></span>`;
  }

  function modelAvailability(model, value) {
    if (model.kind !== 'select' || value === model.selected) return model.availability;
    return value ? { status: 'available' } : model.defaultAvailability;
  }

  function modelError(model, value) {
    const { status, reason } = modelAvailability(model, value);
    if (['available', 'warning', 'unmonitored'].includes(status)) return '';
    return `<p class="inline-error" role="alert" data-block-model-error>${esc(reason)}</p>`;
  }
  function modelNote(model) {
    if (model.kind === 'select') return 'Applies to the next attempt. Earlier attempts keep their original model.';
    return model.reasonInTooltip ? '' : esc(model.reason);
  }

  window.factoryBlockModel = (model, value, actions = '') => {
    if (!model || model.kind === 'none')
      return actions ? `<section class="detail-section" data-block-model-row>${actions}</section>` : '';
    const picker = model.kind === 'fixed' ? fixedModel(model) : modelPicker(model, value);
    const note = modelNote(model);
    return `<section class="detail-section"><div data-block-model-row>${picker}${actions}</div>${note ? `<p class="detail-copy" id="block-model-note">${note}</p>` : ''}${modelError(model, value)}</section>`;
  };
})();
