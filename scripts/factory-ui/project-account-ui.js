{
  const frame = document.querySelector('#factory-project-account iframe');
  const accountOrigin = new URL(frame.src).origin;
  window.addEventListener('message', ({ source, origin, data }) => {
    if (source === frame.contentWindow && origin === accountOrigin) resizeAccountFrame(frame, data);
  });
}

function resizeAccountFrame(frame, data) {
  if (data?.type === 'timey-account-height' && Number.isInteger(data.height))
    frame.height = String(Math.min(288, Math.max(40, data.height)));
}
