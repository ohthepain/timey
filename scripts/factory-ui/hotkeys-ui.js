(() => {
  'use strict';
  let bindings = {};
  const modifiers = { ctrlKey: 'Ctrl', altKey: 'Alt', shiftKey: 'Shift', metaKey: 'Meta' };
  function keyCode(key) {
    if (/^[A-Z]$/.test(key)) return 'Key' + key;
    return /^\d$/.test(key) ? 'Digit' + key : key;
  }
  function keyMatches(event, key) {
    const typed = event.key === ' ' ? 'Space' : event.key;
    return [event.code === keyCode(key), typed?.toUpperCase() === key.toUpperCase()].some(Boolean);
  }
  function matches(event, action, includeRepeats = false) {
    if ([event.repeat && !includeRepeats, event.isComposing, !bindings[action]].some(Boolean)) return false;
    const tokens = bindings[action].split('+');
    const key = tokens.pop();
    const modifiersMatch = Object.entries(modifiers).every(
      ([property, modifier]) => event[property] === tokens.includes(modifier)
    );
    return modifiersMatch && keyMatches(event, key);
  }
  function apply(values) {
    bindings = { ...values };
    const noteButton = document.getElementById('local-note-quick');
    if (noteButton) noteButton.title = bindings.newNote ? `Quick note (${bindings.newNote})` : 'Quick note';
    document.dispatchEvent(new CustomEvent('factory-hotkeys-changed', { detail: bindings }));
  }
  async function refresh() {
    const response = await fetch('/api/project-preferences');
    if (!response.ok) throw new Error('Factory hotkeys could not be loaded.');
    const preferences = await response.json();
    apply(preferences.hotkeys.values);
  }
  window.FactoryHotkeys = { matches, apply, refresh };
  void refresh().catch(() => {});
})();
