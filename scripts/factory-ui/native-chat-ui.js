const issueId = new URL(location.href).searchParams.get('issue');
const status = document.querySelector('#status'),
  discuss = document.querySelector('#discuss'),
  open = document.querySelector('#open');
document.querySelector('#issue').textContent = issueId || 'No issue selected';
function render(value) {
  if (value.error) throw Error(value.error);
  status.textContent =
    value.summary ||
    (value.status === 'ready' ? 'This issue has a registered Codex chat.' : 'No chat has been created.');
  discuss.hidden = value.status !== 'none';
  open.hidden = !value.href;
  if (value.href) open.href = value.href;
  open.textContent = value.status === 'ready' ? 'Open issue chat' : 'Open Codex draft';
}
async function refresh() {
  try {
    render(await (await fetch(`/api/native-chat?issue=${encodeURIComponent(issueId || '')}`)).json());
  } catch (error) {
    status.textContent = error.message;
  }
}
discuss.onclick = async () => {
  discuss.disabled = true;
  try {
    render(
      await (
        await fetch('/api/native-chat-prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Factory-Action': 'manual' },
          body: JSON.stringify({ issueId, mode: 'discuss' }),
        })
      ).json()
    );
  } catch (error) {
    status.textContent = error.message;
  } finally {
    discuss.disabled = false;
  }
};
open.onclick = () => {
  if (open.textContent === 'Open Codex draft') {
    open.hidden = true;
    status.textContent = 'Return to the Codex draft and press Send. Refresh saved status after registration.';
  }
};
document.querySelector('#refresh').onclick = refresh;
refresh();
