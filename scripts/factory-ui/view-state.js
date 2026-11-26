(() => {
  'use strict';

  const prefix = 'timey-view:' + location.pathname + ':';
  const memory = new Map();
  const views = new Map();
  const deferred = new Map();
  let pointer = null;

  function storedValueMatches(value, fallback) {
    if (value === null) return false;
    if (fallback === null) return true;
    return typeof value === typeof fallback && Array.isArray(value) === Array.isArray(fallback);
  }

  function read(key, fallback = null) {
    if (memory.has(key)) return memory.get(key);
    try {
      const value = JSON.parse(sessionStorage.getItem(prefix + key));
      return storedValueMatches(value, fallback) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    memory.set(key, value);
    try {
      sessionStorage.setItem(prefix + key, JSON.stringify(value));
    } catch {
      // Keep the current view usable when browser storage is unavailable or full.
    }
  }

  function identity(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    for (const name of [
      'id',
      'data-view-key',
      'data-ai-key',
      'data-discuss-message',
      'data-message-id',
      'data-attempt-id',
      'data-artifact-run',
      'data-preserve',
      'data-field',
      'data-discuss-question',
      'data-prompt-id',
      'data-view-id',
      'data-step-id',
      'data-block',
      'data-node',
    ]) {
      if (node.hasAttribute(name)) return node.nodeName + ':' + name + ':' + node.getAttribute(name);
    }
    return '';
  }

  function path(node, root) {
    if (node === root) return 'root';
    const parts = [];
    for (let current = node; current !== root; current = current.parentElement) {
      const peers = [...current.parentElement.children].filter((other) => other.nodeName === current.nodeName);
      parts.unshift(identity(current) || current.nodeName + ':' + peers.indexOf(current));
    }
    return JSON.stringify(parts);
  }

  function elements(root) {
    return [root, ...root.querySelectorAll('details,textarea,input,select,pre,[role="log"],[data-view-scroll]')];
  }

  function disclosure(element) {
    return element instanceof HTMLDetailsElement && !element.hasAttribute('data-view-controlled-open');
  }

  function dimensions(element) {
    if (!(element instanceof HTMLTextAreaElement)) return {};
    return { width: element.style.width, height: element.style.height };
  }

  function follows(element, selected) {
    return (
      element.matches('[role="log"], [data-chat-scroll]') &&
      !selected &&
      element.scrollHeight - element.scrollTop - element.clientHeight < 2
    );
  }

  function captureElement(element, selected) {
    return {
      ...dimensions(element),
      open: disclosure(element) ? element.open : undefined,
      top: element.scrollTop,
      left: element.scrollLeft,
      follow: follows(element, selected),
    };
  }

  function remember(root) {
    const view = views.get(root);
    if (!view || root.closest('[hidden]')) return;
    const selected = Boolean(captureSelection(root));
    write(
      view.scope,
      Object.fromEntries(elements(root).map((element) => [path(element, root), captureElement(element, selected)]))
    );
  }

  function restoreDimensions(element, saved) {
    if (!(element instanceof HTMLTextAreaElement)) return;
    if (saved.width) element.style.width = saved.width;
    if (saved.height) element.style.height = saved.height;
  }

  function restoreDisclosure(element, saved) {
    if (saved.open !== undefined && disclosure(element)) element.open = saved.open;
  }

  function restoreElement(element, saved) {
    if (!saved) return;
    restoreDisclosure(element, saved);
    restoreDimensions(element, saved);
    element.scrollTop = saved.follow ? element.scrollHeight : saved.top;
    element.scrollLeft = saved.left;
  }

  function restore(root, scope) {
    const values = read(scope, {});
    for (const element of elements(root)) restoreElement(element, values[path(element, root)]);
  }

  function compatible(current, next) {
    return (
      current.nodeType === next.nodeType && current.nodeName === next.nodeName && identity(current) === identity(next)
    );
  }

  function candidateNode(next, cursor, keyed) {
    return keyed.get(identity(next)) || cursor;
  }

  function placeNode(root, next, cursor, current) {
    if (!current || !compatible(current, next)) {
      root.insertBefore(next, cursor);
      return next;
    }
    if (current !== cursor) root.insertBefore(current, cursor);
    patch(current, next);
    return current;
  }

  function patchChildren(root, source) {
    let cursor = root.firstChild;
    const keyed = new Map([...root.childNodes].filter(identity).map((node) => [identity(node), node]));
    for (const next of [...source.childNodes]) {
      const current = placeNode(root, next, cursor, candidateNode(next, cursor, keyed));
      cursor = current.nextSibling;
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  }

  function attributes(element) {
    if (disclosure(element)) return [...element.attributes].filter(({ name }) => name !== 'open');
    return [...element.attributes];
  }

  function patchAttributes(current, next) {
    for (const attribute of attributes(current)) {
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    applyAttributes(current, next);
  }

  function applyAttributes(current, next) {
    for (const attribute of attributes(next)) {
      if (current.getAttribute(attribute.name) !== attribute.value)
        current.setAttribute(attribute.name, attribute.value);
    }
  }

  function patchText(current, next) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
  }

  function patchValue(current, next, changed) {
    if (changed && current.value !== next.value) current.value = next.value;
  }

  function patch(current, next) {
    if (current.nodeType !== Node.ELEMENT_NODE) return patchText(current, next);
    if (window.FactoryTextControls?.preserve(current, next)) return;
    patchElement(current, next);
  }

  function patchElement(current, next) {
    const changedValue = current.defaultValue !== next.defaultValue;
    const changedCheck = current.defaultChecked !== next.defaultChecked;
    if (typeof next.onclick === 'function') current.onclick = next.onclick;
    patchAttributes(current, next);
    patchChildren(current, next);
    patchValue(current, next, changedValue);
    if (changedCheck) current.checked = next.checked;
  }

  function hasSelection(selection) {
    return selection?.rangeCount && !selection.isCollapsed;
  }

  function containsSelection(root, selection) {
    return root.contains(selection.anchorNode) || root.contains(selection.focusNode);
  }

  function bookmark(node, root) {
    if (!root.contains(node)) return null;
    if (node.nodeType !== Node.TEXT_NODE) return { path: path(node, root), text: false };
    return { path: path(node.parentElement, root), text: true, index: [...node.parentNode.childNodes].indexOf(node) };
  }

  function captureSelection(root) {
    const selection = window.getSelection();
    if (!hasSelection(selection)) return null;
    if (!containsSelection(root, selection)) return null;
    return {
      anchor: selection.anchorNode,
      start: selection.anchorOffset,
      focus: selection.focusNode,
      end: selection.focusOffset,
      text: selection.toString(),
      anchorPoint: bookmark(selection.anchorNode, root),
      focusPoint: bookmark(selection.focusNode, root),
    };
  }

  function findBookmark(root, point) {
    if (!point) return null;
    const parent = [root, ...root.querySelectorAll('*')].find((element) => path(element, root) === point.path);
    if (!parent) return null;
    return point.text ? parent.childNodes[point.index] : parent;
  }

  function resolvePoint(node, point, root) {
    if (node.isConnected) return node;
    if (!root) return null;
    return findBookmark(root, point);
  }

  function resolveSelection(saved, root) {
    if (!saved) return null;
    const anchor = resolvePoint(saved.anchor, saved.anchorPoint, root);
    const focus = resolvePoint(saved.focus, saved.focusPoint, root);
    if (!anchor || !focus) return null;
    return { ...saved, anchor, focus };
  }

  function matchesSelection(selection, saved) {
    return [
      selection.anchorNode === saved.anchor,
      selection.anchorOffset === saved.start,
      selection.focusNode === saved.focus,
      selection.focusOffset === saved.end,
      selection.toString() === saved.text,
    ].every(Boolean);
  }

  function selectedRange(saved) {
    const range = document.createRange();
    range.setStart(saved.anchor, saved.start);
    range.setEnd(saved.focus, saved.end);
    if (range.collapsed) {
      range.setStart(saved.focus, saved.end);
      range.setEnd(saved.anchor, saved.start);
    }
    return range;
  }

  function applySelection(selection, saved) {
    try {
      const range = selectedRange(saved);
      if (range.toString() === saved.text)
        selection.setBaseAndExtent(saved.anchor, saved.start, saved.focus, saved.end);
      else selection.removeAllRanges();
    } catch {
      // A selection whose text was removed has no matching range to restore.
    }
  }

  function restoreSelection(saved, root) {
    const resolved = resolveSelection(saved, root);
    if (!resolved) return;
    const selection = window.getSelection();
    if (!matchesSelection(selection, resolved)) applySelection(selection, resolved);
  }

  function caret(field) {
    if (!field.setSelectionRange) return null;
    if (typeof field.selectionStart !== 'number') return null;
    return [field.selectionStart, field.selectionEnd, field.selectionDirection];
  }

  function focusState(root) {
    const field = document.activeElement;
    if (!root.contains(field)) return null;
    return { field, caret: caret(field) };
  }

  function restoreCaret(field, saved) {
    if (!saved) return;
    if (field.selectionStart !== saved[0] || field.selectionEnd !== saved[1]) field.setSelectionRange(...saved);
  }

  function restoreFocus(saved) {
    if (!saved) return;
    if (!saved.field.isConnected) return;
    if (document.activeElement !== saved.field) saved.field.focus({ preventScroll: true });
    restoreCaret(saved.field, saved.caret);
  }

  function dragging(root) {
    return Boolean(pointer && root.contains(pointer));
  }

  function canDefer(root, scope) {
    return dragging(root) && views.get(root)?.scope === scope;
  }

  function prepareRender(root, scope) {
    deferred.delete(root);
    const previous = views.get(root);
    if (previous) remember(root);
    return previous?.scope === scope;
  }

  function interactionState(root, same) {
    if (!same) return {};
    return { selection: captureSelection(root), focus: focusState(root) };
  }

  function markup(html) {
    const template = document.createElement('template');
    if (typeof html === 'string') template.innerHTML = html;
    else template.content.append(html);
    return template.content;
  }

  function updateMarkup(root, content, reconcile) {
    if (reconcile) return patchChildren(root, content);
    root.replaceChildren(content);
    root.scrollTop = 0;
    root.scrollLeft = 0;
  }

  function render(root, html, scope = root.id, replace = false) {
    if (!root) return;
    if (canDefer(root, scope)) {
      deferred.set(root, { html, scope, replace });
      return;
    }
    const same = prepareRender(root, scope);
    const saved = interactionState(root, same);
    updateMarkup(root, markup(html), same && !replace);
    views.set(root, { scope });
    window.FactoryTextControls?.refresh(root);
    restore(root, scope);
    restoreFocus(saved.focus);
    restoreSelection(saved.selection, root);
  }

  function resetDimensions(root) {
    if (!(root instanceof HTMLTextAreaElement)) return;
    root.style.width = '';
    root.style.height = '';
  }

  function track(root, scope) {
    const previous = views.get(root);
    if (previous?.scope === scope) return;
    if (previous) remember(root);
    views.set(root, { scope });
    resetDimensions(root);
    root.scrollTop = 0;
    restore(root, scope);
  }

  function updateText(element, value) {
    if (element.childNodes.length === 1 && element.firstChild.nodeType === Node.TEXT_NODE)
      element.firstChild.nodeValue = value;
    else element.textContent = value;
  }

  function text(element, value) {
    const next = String(value ?? '');
    if (element.textContent === next) return void deferred.delete(element);
    if (dragging(element)) return void deferred.set(element, { text: next });
    deferred.delete(element);
    const selection = captureSelection(element);
    updateText(element, next);
    restoreSelection(selection);
  }

  function affected(root, event) {
    return !event || root.contains(event.target);
  }

  function saveViews(event) {
    for (const [root] of views) {
      if (!root.isConnected) views.delete(root);
      else if (affected(root, event)) remember(root);
    }
  }

  function flushRender(root, value) {
    if (!root.isConnected) return;
    if (value.text !== undefined) text(root, value.text);
    else render(root, value.html, value.scope, value.replace);
  }

  function finishPointer() {
    pointer = null;
    for (const [root, value] of [...deferred]) flushRender(root, value);
    deferred.clear();
    saveViews();
  }

  document.addEventListener(
    'pointerdown',
    (event) => {
      pointer = event.target.closest('[data-block-grip]') ? null : event.target;
    },
    true
  );
  document.addEventListener('pointerup', finishPointer, true);
  document.addEventListener('pointercancel', finishPointer, true);
  window.addEventListener('blur', finishPointer);
  for (const name of ['scroll', 'toggle', 'input', 'change']) document.addEventListener(name, saveViews, true);
  window.addEventListener('pagehide', () => saveViews());
  window.timeyView = {
    render,
    text,
    read,
    write,
    remember,
    track,
    dragging,
    follows,
    captureSelection,
    restoreSelection,
  };
})();
