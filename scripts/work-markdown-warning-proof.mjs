import { writeFileSync } from 'node:fs';

export async function traceWorkMarkdown(page, output, candidate, watcherEvents, { write, assertRendered, invalid }) {
  const trace = await page.evaluateHandle((observeWarning) => {
    const times = {};
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    window.addEventListener('factory-sources-changed', () => (times.browserNotified ??= Date.now()), options);
    function warning() {
      const status = document.getElementById('view-source-status');
      if (!status.hidden && status.textContent.includes('needs a paragraph')) times.warningApplied ??= Date.now();
    }
    function validSource(event) {
      const work = event.detail.find((entry) => entry.document && entry.id.endsWith('/work'));
      if (work?.description === 'Ready when you are.') times.validSourceApplied ??= Date.now();
    }
    document.addEventListener('factory-ui-sources', observeWarning ? warning : validSource, options);
    return { listeners, times };
  }, Boolean(invalid));
  const writeStarted = Date.now();
  write();
  const writeFinished = Date.now();
  let assertionPassed;
  try {
    await assertRendered();
    assertionPassed = Date.now();
  } finally {
    const { browserNotified, warningApplied, validSourceApplied } = await trace.evaluate(({ listeners, times }) => {
      listeners.abort();
      return times;
    });
    const watcherObserved = watcherEvents.find(({ at }) => at >= writeStarted)?.at;
    const applied = invalid ? { warningApplied } : { validSourceApplied };
    const events = { writeStarted, writeFinished, watcherObserved, browserNotified, ...applied, assertionPassed };
    const firstMissing = Object.keys(events).find((event) => events[event] === undefined);
    writeFileSync(output, JSON.stringify({ ...candidate, events, firstMissing: firstMissing ?? null }, null, 2) + '\n');
    await trace.dispose();
  }
}
