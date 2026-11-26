window.timeyEscapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
window.timeyChatSendIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5"/></svg>';
function spokenInsertion(before, text, after) {
  if (after) return before + text + after;
  if (!before) return text;
  if (/\s$/.test(before)) return before + text;
  return before + ' ' + text;
}
function dictationParts(draft) {
  const original = draft.value;
  const caret = window.FactoryTextControls?.selection(draft) || { start: original.length, end: original.length };
  return [original.slice(0, caret.start), original.slice(caret.end)];
}
window.createChatDictation = ({ button, draft, status, getConversationId, changed, submit }) => {
  let recognition = null;
  let disposed = false;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  button.addEventListener('click', () => {
    if (!SpeechRecognition) {
      status.textContent = 'Dictation is unavailable in this browser. You can keep typing.';
      return;
    }
    if (recognition) {
      recognition.stop();
      return;
    }
    const original = draft.value;
    const [before, after] = dictationParts(draft);
    const dictation = { conversationId: getConversationId(), draft: original, finalTranscript: '' };
    const isCurrentDictation = () =>
      !disposed && getConversationId() === dictation.conversationId && draft.value === dictation.draft;
    function sendSpokenPrompt() {
      if (!isCurrentDictation()) return;
      if (!/(?:^|\s)go[.!?]*\s*$/i.test(dictation.finalTranscript)) return;
      dictation.finalTranscript = '';
      draft.value = draft.value.replace(/(?:^|\s)go[.!?]*\s*$/i, '').trimEnd();
      changed();
      status.textContent = 'Dictation finished. There is no prompt to send.';
      if (!draft.value.trim()) return;
      status.textContent = 'Dictation finished. Sending your prompt.';
      submit();
    }
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (!isCurrentDictation()) return;
      const text = [...event.results].map((result) => result[0].transcript).join(' ');
      dictation.finalTranscript = [...event.results].every((result) => result.isFinal) ? text : '';
      dictation.draft = spokenInsertion(before, text, after);
      draft.value = dictation.draft;
      changed();
    };
    recognition.onerror = (event) => {
      dictation.finalTranscript = '';
      status.textContent = 'Dictation failed: ' + event.error + '. Your draft is preserved; retry or type.';
    };
    recognition.onend = () => {
      recognition = null;
      button.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="2" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2m-2 0h4"/></svg>';
      button.setAttribute('aria-label', 'Start dictation');
      button.title = 'Dictate';
      sendSpokenPrompt();
      if (status.textContent === 'Listening…') status.textContent = 'Dictation finished. Edit the text before sending.';
    };
    try {
      recognition.start();
      status.textContent = 'Listening…';
      button.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>';
      button.setAttribute('aria-label', 'Stop dictation');
      button.title = 'Stop dictation';
    } catch (failure) {
      recognition = null;
      status.textContent = 'Dictation could not start. Your draft is preserved. ' + failure.message;
    }
  });
  return {
    stop() {
      disposed = true;
      recognition?.stop();
    },
  };
};

function chatAiAttributes(user, source, key, id) {
  if (user || source === undefined) return '';
  const escape = window.timeyEscapeHTML;
  return ` data-ai-text data-ai-key="${escape(key || id)}" data-ai-source="${escape(source)}"`;
}
window.chatMessageMarkup = ({ id, user, label, meta = '', content = '', tail = '', aiSource, aiKey }) => {
  const escape = window.timeyEscapeHTML;
  const attributes = chatAiAttributes(user, aiSource, aiKey, id);
  return `<article class="discuss-message ${user ? 'user' : 'assistant'}" data-discuss-message="${escape(id)}"><div class="discuss-message-heading"><strong>${escape(label || (user ? 'You' : 'Assistant'))}</strong><span class="muted">${escape(meta)}</span></div><div class="discuss-message-body"${attributes}>${content}</div>${tail}</article>`;
};

window.createSkillComposer = function createSkillComposer(form, draft, load) {
  const selector = document.createElement('div');
  selector.className = 'skill-selector';
  selector.setAttribute('role', 'listbox');
  selector.hidden = true;
  const chips = document.createElement('div');
  chips.className = 'skill-chips';
  chips.hidden = true;
  let anchor = draft;
  while (anchor.parentElement !== form) anchor = anchor.parentElement;
  form.insertBefore(selector, anchor);
  form.insertBefore(chips, anchor);
  let options = [],
    selected = [],
    loaded = null,
    query = '',
    start = 0,
    active = 0,
    allowed = true,
    busy = false,
    generation = 0;
  const matches = () =>
    options.filter(
      (skill) =>
        !selected.some((item) => item.name === skill.name) &&
        `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    );
  function render() {
    chips.replaceChildren();
    for (const skill of selected) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'skill-chip';
      chip.dataset.skill = skill.name;
      chip.setAttribute('aria-label', `Remove ${skill.name} skill`);
      const icon = document.createElement('span');
      icon.textContent = skill.icon || '✦';
      const label = document.createElement('span');
      label.textContent = skill.name;
      const remove = document.createElement('span');
      remove.className = 'skill-chip-remove';
      remove.setAttribute('aria-hidden', 'true');
      remove.textContent = '×';
      chip.append(icon, label, remove);
      chip.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        selected = selected.filter((item) => item.name !== skill.name);
        render();
        draft.dispatchEvent(new Event('input', { bubbles: true }));
        draft.focus();
      });
      chips.append(chip);
    }
    chips.hidden = selected.length === 0;
  }
  function close() {
    generation++;
    selector.hidden = true;
    selector.replaceChildren();
  }
  function show() {
    if (!allowed || !matches().length) {
      close();
      return;
    }
    const found = matches();
    active = Math.min(active, found.length - 1);
    selector.replaceChildren();
    found.forEach((skill, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'skill-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      const icon = document.createElement('span');
      icon.className = 'skill-option-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = skill.icon || '✦';
      const details = document.createElement('span');
      details.className = 'skill-option-details';
      const name = document.createElement('strong');
      name.textContent = skill.name;
      const description = document.createElement('span');
      description.textContent = skill.description;
      const source = document.createElement('small');
      source.textContent = skill.source;
      details.append(name, description);
      option.append(icon, details, source);
      option.addEventListener('click', (event) => {
        if (event.isTrusted) choose(skill);
      });
      selector.append(option);
    });
    selector.hidden = false;
  }
  function choose(skill) {
    if (selected.length >= 8 || selected.some((item) => item.name === skill.name)) return;
    selected.push(skill);
    draft.setRangeText('', start, draft.selectionStart, 'end');
    render();
    close();
    draft.focus();
    draft.dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function querySkills(value, slashStart) {
    const request = ++generation;
    query = value;
    start = slashStart;
    if (!loaded) {
      if (!busy) {
        busy = true;
        loaded = Promise.resolve()
          .then(load)
          .then((result) => (options = result.skills || result));
      }
      try {
        await loaded;
      } catch (error) {
        if (request !== generation) return;
        loaded = null;
        selector.replaceChildren();
        const message = document.createElement('p');
        message.textContent = `Skills could not load: ${error.message}`;
        selector.append(message);
        selector.hidden = false;
        return;
      } finally {
        busy = false;
      }
    }
    if (request !== generation) return;
    active = 0;
    show();
  }
  draft.addEventListener('input', () => {
    const before = draft.value.slice(0, draft.selectionStart);
    const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
    if (!match) return close();
    const slash = before.lastIndexOf('/');
    void querySkills(match[1], slash);
  });
  draft.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !draft.value && selected.length && allowed) {
      event.preventDefault();
      selected.pop();
      render();
      return;
    }
    if (selector.hidden) return;
    const count = matches().length;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      active = (active + 1) % count;
      show();
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      active = (active + count - 1) % count;
      show();
    } else if (['Enter', 'Tab'].includes(event.key) && !event.shiftKey && !event.isComposing && count) {
      event.preventDefault();
      choose(matches()[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  return {
    isOpen: () => !selector.hidden,
    refresh: () => {
      loaded = null;
      options = [];
    },
    skills: () => selected.map((skill) => skill.name),
    reset: () => {
      selected = [];
      render();
      close();
    },
    allow: (value) => {
      allowed = Boolean(value);
      if (!allowed) close();
    },
    canSubmit: (text) => Boolean(text.trim() || (allowed && selected.length)),
    restore: (names) => {
      selected = names.map((name) => options.find((item) => item.name === name) || { name });
      render();
      close();
    },
    render,
  };
};
