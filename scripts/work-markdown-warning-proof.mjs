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
  const started = performance.now();
  const writeStarted = Date.now();
  let writeFinished;
  let assertionPassed;
  try {
    write();
    writeFinished = Date.now();
    await assertRendered();
    assertionPassed = Date.now();
  } finally {
    let browserTraceError;
    const { browserNotified, warningApplied, validSourceApplied } = await trace
      .evaluate(({ listeners, times }) => {
        listeners.abort();
        return times;
      })
      .catch((error) => {
        browserTraceError = error.message;
        return {};
      });
    const watcherObserved = watcherEvents.find(({ at }) => at >= writeStarted)?.at;
    const applied = invalid ? { warningApplied } : { validSourceApplied };
    const events = { writeStarted, writeFinished, watcherObserved, browserNotified, ...applied, assertionPassed };
    const firstMissing = Object.keys(events).find((event) => events[event] === undefined);
    const recordedEvents = Object.fromEntries(Object.entries(events).map(([event, at]) => [event, at ?? null]));
    const elapsedMs = Math.round(performance.now() - started);
    writeFileSync(
      output,
      JSON.stringify(
        { ...candidate, elapsedMs, events: recordedEvents, firstMissing: firstMissing ?? null, browserTraceError },
        null,
        2
      ) + '\n'
    );
    await trace.dispose().catch(() => {});
  }
}
