(() => {
  'use strict';
  const states = new Map();
  const mounted = new WeakMap();
  const carets = new WeakMap();
  let hovered = null;
  let recording = null;
  const fieldSelector = 'textarea:not([readonly]):not([disabled]), input[type="text"]:not([readonly]):not([disabled])';
  function button(action, label) {
    const element = document.createElement('button');
    element.className = 'ai-text-button';
    element.textContent = label;
    element.type = 'button';
    element.dataset.aiAction = action;
    element.setAttribute('aria-label', label);
    element.title = action === 'dictate' ? 'Dictate (Alt+D)' : label;
    if (action === 'bro') element.setAttribute('aria-pressed', 'false');
    return element;
  }
  function controls(block, ai) {
    const toolbar = document.createElement('div');
    toolbar.className = 'ai-text-controls';
    toolbar.dataset.aiControls = '';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', ai ? 'AI text controls' : 'Text dictation');
    if (ai) toolbar.append(button('copy', 'Copy'), button('bro', 'Bro'));
    toolbar.append(button('dictate', 'Dictate'));
    const status = document.createElement('span');
    status.className = 'ai-text-status';
    status.dataset.aiStatus = '';
    status.setAttribute('role', 'status');
    toolbar.append(status);
    block.append(toolbar);
    return { toolbar, status };
  }
  function currentSource(block) {
    return block.dataset.aiSource ?? block.textContent;
  }
  function alreadyMounted(block) {
    if (!mounted.has(block)) return false;
    return Boolean(block.querySelector(':scope > .ai-text-controls'));
  }
  function readState(block, source) {
    const key = block.dataset.aiKey || source;
    const previous = states.get(key) || { enabled: false };
    if (previous.source === source) return previous;
    const state = { source, enabled: previous.enabled, simplified: null, edits: {}, pending: false };
    states.set(key, state);
    return state;
  }
  function changedSource(view, block) {
    if (!view) return false;
    if (!view.state) return false;
    return block.dataset.aiSource !== undefined && view.state.source !== block.dataset.aiSource;
  }
  function resetChangedSource(block) {
    const view = mounted.get(block);
    if (!changedSource(view, block)) return;
    if (block.contains(view.original)) block.replaceChildren(...view.original.childNodes);
  }
  function mountText(block) {
    resetChangedSource(block);
    if (alreadyMounted(block)) return;
    const source = currentSource(block);
    if (!source.trim()) return;
    createTextView(block, readState(block, source));
  }
  function createTextView(block, state) {
    const original = document.createElement('div');
    original.className = 'ai-text-original';
    original.dataset.aiOriginal = '';
    original.append(...block.childNodes);
    const simplified = document.createElement('div');
    simplified.className = 'ai-text-simplified';
    simplified.dataset.aiSimplified = '';
    simplified.hidden = true;
    block.append(original, simplified);
    block.classList.add('ai-text-block');
    const view = { block, state, original, simplified, ...controls(block, true), editor: null };
    mounted.set(block, view);
    connectEditableField(view);
    if (state.editing) editable(view);
    paint(view);
    requestSimplified(view);
  }
  function connectEditableField(view) {
    view.field = view.original.querySelector(fieldSelector);
    if (!view.field) return;
    view.field.addEventListener('input', () => changedField(view));
  }
  function changedField(view) {
    if (view.field.value !== displayed(view)) saveEdit(view, view.field);
  }
  function saveEdit(view, field) {
    view.state.edits[view.state.enabled ? 'bro' : 'original'] = field.value;
    if (!view.state.enabled) invalidateSimplified(view.state);
  }
  function invalidateSimplified(state) {
    state.simplified = null;
    delete state.edits.bro;
  }
  function requestSimplified(view) {
    if (!view.state.enabled) return;
    if (view.state.simplified === null) void simplify(view);
  }
  function paint(view) {
    const bro = view.toolbar.querySelector('[data-ai-action="bro"]');
    bro.setAttribute('aria-pressed', String(view.state.enabled));
    bro.textContent = view.state.pending ? 'Bro…' : 'Bro';
    view.block.classList.toggle('ai-text-bro-on', view.state.enabled);
    view.block.dataset.aiBroOn = String(view.state.enabled);
    paintText(view);
  }
  function hasSimplified(state) {
    return state.enabled && state.simplified !== null;
  }
  function paintText(view) {
    if (view.field) return paintField(view);
    const transformed = hasSimplified(view.state);
    paintVisibility(view, transformed);
    view.simplified.textContent = view.state.simplified;
    paintEditor(view);
  }
  function paintVisibility(view, transformed) {
    if (view.editor) {
      view.original.hidden = true;
      view.simplified.hidden = true;
      return;
    }
    view.original.hidden = transformed;
    view.simplified.hidden = !transformed;
  }
  function paintEditor(view) {
    if (view.editor) view.editor.value = displayed(view);
  }
  function paintField(view) {
    view.simplified.hidden = true;
    const value = displayed(view);
    if (view.field.value === value) return;
    view.field.value = value;
    view.field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function displayed(view) {
    const mode = view.state.enabled ? 'bro' : 'original';
    return view.state.edits[mode] ?? modeText(view.state);
  }
  function modeText(state) {
    if (state.enabled && state.simplified !== null) return state.simplified;
    return state.source;
  }
  async function simplify(view) {
    const { state, status } = view;
    if (state.pending) return;
    state.pending = true;
    paint(view);
    status.textContent = 'Making text easier to read…';
    try {
      const response = await fetch('/api/ai-text-bro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
        body: JSON.stringify({ text: state.edits.original ?? state.source }),
      });
      const result = await response.json();
      checkResponse(response, result);
      state.simplified = result.text;
      status.textContent = '';
    } catch (error) {
      state.enabled = false;
      status.textContent = error.message;
    } finally {
      state.pending = false;
      repaintState(state);
    }
  }
  function checkResponse(response, result) {
    if (!response.ok) throw new Error(result.error || 'Bro could not finish.');
  }
  function repaintState(state) {
    document.querySelectorAll('[data-ai-text]').forEach((block) => {
      const current = mounted.get(block);
      if (current?.state === state) paint(current);
    });
  }
  function editable(view) {
    if (view.field) return view.field;
    if (!view.editor) {
      const label = document.createElement('label');
      label.className = 'ai-text-edit-label';
      label.dataset.aiEditLabel = '';
      label.textContent = 'Local text edit';
      const editor = document.createElement('textarea');
      editor.className = 'ai-text-editor';
      editor.dataset.aiEditor = '';
      editor.setAttribute('aria-label', 'Local edit of AI text');
      editor.rows = 5;
      editor.value = displayed(view);
      label.append(editor);
      view.block.append(label);
      view.editor = editor;
      view.state.editing = true;
      editor.addEventListener('input', () => {
        saveEdit(view, editor);
      });
      paint(view);
    }
    return view.editor;
  }
  function refresh(root = document) {
    root.querySelectorAll('[data-ai-text]').forEach(mountText);
  }
  function fieldView(field) {
    let view = mounted.get(field);
    if (view) return view;
    const block = document.createElement('div');
    block.className = 'ai-text-field';
    block.dataset.aiFloating = '';
    document.body.append(block);
    view = { block, field, ...controls(block, false) };
    mounted.set(block, view);
    mounted.set(field, view);
    return view;
  }
  function hoverField(field) {
    const view = fieldView(field);
    const host = field.closest('dialog[open]') || document.body;
    host.append(view.block);
    const bounds = field.getBoundingClientRect();
    view.block.style.top = bounds.top + 'px';
    view.block.style.left = bounds.left + 'px';
    view.block.style.width = bounds.width + 'px';
    view.block.hidden = false;
    hovered = view.block;
  }
  function dictate(view) {
    if (recording) {
      recording.stop();
      return;
    }
    const Recognition = speechRecognition();
    if (!Recognition) {
      view.status.textContent = 'Dictation is unavailable in this browser. You can keep typing.';
      return;
    }
    const field = editable(view);
    const original = field.value;
    const caret = selection(field);
    const before = original.slice(0, caret.start);
    const after = original.slice(caret.end);
    let expected = original;
    const recognizer = new Recognition();
    recognizer.continuous = false;
    recognizer.interimResults = true;
    recognizer.onresult = (event) => {
      if (!acceptsTranscript(field, expected)) return;
      const insertion = [...event.results].map((result) => result[0].transcript).join(' ');
      expected = before + insertion + after;
      field.value = expected;
      field.setSelectionRange(before.length + insertion.length, before.length + insertion.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    recognizer.onerror = (event) => {
      view.status.textContent = 'Dictation failed. ' + event.error;
    };
    recognizer.onend = () => endDictation(view);
    try {
      field.focus({ preventScroll: true });
      field.setSelectionRange(caret.start, caret.end);
      recording = recognizer;
      recognizer.start();
      view.status.textContent = 'Listening…';
      view.toolbar.querySelector('[data-ai-action="dictate"]').textContent = 'Stop';
    } catch (error) {
      recording = null;
      view.status.textContent = 'Dictation could not start. ' + error.message;
    }
  }
  function speechRecognition() {
    return window.SpeechRecognition || window.webkitSpeechRecognition;
  }
  function acceptsTranscript(field, expected) {
    return field.isConnected && field.value === expected;
  }
  function endDictation(view) {
    recording = null;
    view.toolbar.querySelector('[data-ai-action="dictate"]').textContent = 'Dictate';
    if (view.status.textContent === 'Listening…') view.status.textContent = 'Dictation finished.';
  }
  function selection(field) {
    return carets.get(field) || { start: field.value.length, end: field.value.length };
  }
  function trackSelection() {
    const field = document.activeElement;
    if (field?.matches(fieldSelector)) carets.set(field, { start: field.selectionStart, end: field.selectionEnd });
  }
  function pointerOver(event) {
    const block = event.target.closest('.ai-text-block, .ai-text-field');
    if (block) {
      hovered = block;
      return;
    }
    const field = event.target.closest(fieldSelector);
    if (field) hoverField(field);
  }
  function pointerOut(event) {
    if (!hovered) return;
    const view = mounted.get(hovered);
    if (staysInside(view, event.relatedTarget)) return;
    if (view.block.hasAttribute('data-ai-floating')) view.block.hidden = true;
    hovered = null;
  }
  function staysInside(view, related) {
    return view.block.contains(related) || view.field === related;
  }
  function preventControlFocus(event) {
    if (event.target.closest('.ai-text-controls')) event.preventDefault();
  }
  async function copy(view) {
    try {
      await navigator.clipboard.writeText(displayed(view));
      view.status.textContent = 'Copied';
    } catch (error) {
      view.status.textContent = 'Copy failed. ' + error.message;
    }
  }
  function toggleBro(view) {
    view.state.enabled = !view.state.enabled;
    paint(view);
    requestSimplified(view);
  }
  const actions = { dictate, bro: toggleBro, copy };
  function click(event) {
    const action = event.target.closest('[data-ai-action]');
    if (!action) return;
    const view = mounted.get(action.closest('.ai-text-block, .ai-text-field'));
    if (view) void actions[action.dataset.aiAction](view);
  }
  function isDictationKey(event) {
    return event.altKey && event.code === 'KeyD' && !event.repeat;
  }
  function keydown(event) {
    if (!isDictationKey(event)) return;
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    routeDictation();
  }
  function routeDictation() {
    if (hovered) return dictate(mounted.get(hovered));
    routeFocusedDictation(document.activeElement);
  }
  function routeFocusedDictation(focused) {
    const view = mounted.get(focused.closest('.ai-text-block, .ai-text-field'));
    if (view) return dictate(view);
    if (focused.matches(fieldSelector)) return dictate(fieldView(focused));
    document.getElementById('discuss-mic')?.click();
  }
  function preserve(current, next) {
    const view = mounted.get(current);
    if (!view?.state) return false;
    if (current.dataset.aiKey !== next.dataset.aiKey) return false;
    return sameSource(view, next);
  }
  function sameSource(view, next) {
    return view.state.source === currentSource(next) && view.original.innerHTML === next.innerHTML;
  }
  document.addEventListener('selectionchange', trackSelection);
  document.addEventListener('pointerover', pointerOver);
  document.addEventListener('pointerout', pointerOut);
  document.addEventListener('pointerdown', preventControlFocus);
  document.addEventListener('click', click);
  document.addEventListener('keydown', keydown, true);
  window.FactoryTextControls = { refresh, selection, preserve };
  const observer = new MutationObserver(() => refresh());
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-ai-source'],
  });
  refresh();
})();
