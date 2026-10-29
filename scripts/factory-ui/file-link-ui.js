// Turns file paths in displayed text into buttons. The server still decides whether a path can be read.
const fileLinkUI = (() => {
  const token =
    /(?:\.{1,2}\/)+(?:[\w.+@~-]+\/)*[\w.+@~-]+\.[A-Za-z0-9]{1,12}|\/(?:[\w.+@~-]+\/)+[\w.+@~-]+\.[A-Za-z0-9]{1,12}|(?:\.?[\w.+@~-]+\/)+[\w.+@~-]+\.[A-Za-z0-9]{1,12}/;
  const pathPattern = new RegExp('(^|[\\s"\'`(])(' + token.source + ')', 'g');
  function esc(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }
  function html(text) {
    const source = String(text ?? '');
    let out = '';
    let last = 0;
    for (const match of source.matchAll(pathPattern)) {
      const path = match[2];
      const start = match.index + match[1].length;
      out += esc(source.slice(last, start));
      out += `<button type="button" class="file-link" data-open-file="${esc(path)}">${esc(path)}</button>`;
      last = start + path.length;
    }
    return out + esc(source.slice(last));
  }
  return { html };
})();
