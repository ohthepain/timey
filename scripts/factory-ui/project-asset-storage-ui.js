(() => {
  'use strict';
  const pageSize = 25;
  const bytes = (size) => new Intl.NumberFormat().format(size) + ' bytes';
  const sum = (rows) => rows.reduce((total, row) => total + row.bytes, 0);
  const orders = {
    name: (a, b) => a.name.localeCompare(b.name),
    size: (a, b) => b.bytes - a.bytes,
    date: (a, b) => (b.observedAt || '').localeCompare(a.observedAt || ''),
  };

  window.renderProjectAssetStorage = (container, { assets, stores, unavailableReferenceSources }, esc) => {
    if (!stores.length) {
      container.textContent = 'No S3 Artifact stores are configured for this project.';
      return;
    }
    const unavailable = stores.filter((store) => !store.available);
    const option = (value, label = value) => `<option value="${esc(value)}">${esc(label)}</option>`;
    const types = [...new Set(assets.map((asset) => asset.mediaType))].sort();
    const storeNames = new Map(stores.map(({ id, label }) => [id, label]));
    container.innerHTML = `
      <p>Read-only inventory. Counts include shared records, retained revisions, and matching local report and Discuss files.
        Reference coverage is unverified. Review assets with zero recorded references before any deletion.</p>
      ${unavailableReferenceSources ? '<p role="status">Some retained records could not be read. Counts may be incomplete.</p>' : ''}
      ${unavailable.length ? `<p role="status">Stores unavailable: ${unavailable.map(({ label }) => esc(label)).join(', ')}.</p>` : ''}
      <div data-asset-filters>
        <label>Asset type <select name="type">${option('', 'All types')}${types.map((type) => option(type)).join('')}</select></label>
        <label>Store <select name="store">${option('', 'All stores')}${stores.map(({ id, label }) => option(id, label)).join('')}</select></label>
        <label>Recorded references <select name="references">
          <option value="">All assets</option><option value="found">References found</option><option value="zero">No recorded references</option>
        </select></label>
        <label>Sort by <select name="sort">
          <option value="name">Name</option><option value="size">Size</option><option value="date">Object date</option>
        </select></label>
      </div>
      <p data-asset-totals role="status"></p>
      <div data-asset-table tabindex="0" role="region" aria-label="Project assets">
        <table>
          <thead><tr><th><label><input type="checkbox" data-asset-select-page> Select all</label></th>
          <th scope="col">Asset</th><th scope="col">Store</th><th scope="col">Size</th>
          <th scope="col">Object date</th><th scope="col">References</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div data-asset-filters>
        <button type="button" data-asset-previous>Previous</button>
        <span data-asset-page></span>
        <button type="button" data-asset-next>Next</button>
      </div>`;
    initializeTable(container, assets, storeNames, esc);
  };

  function initializeTable(container, assets, storeNames, esc) {
    const selected = new Set();
    const controls = container.querySelector('[data-asset-filters]');
    const selectPage = container.querySelector('[data-asset-select-page]');
    const body = container.querySelector('tbody');
    const previous = container.querySelector('[data-asset-previous]');
    const next = container.querySelector('[data-asset-next]');
    const totals = container.querySelector('[data-asset-totals]');
    const pageLabel = container.querySelector('[data-asset-page]');
    let page = 0;
    let visible = [];
    let filtered = [];

    function updateSelection() {
      const current = visible.filter((asset) => selected.has(asset.id)).length;
      selectPage.disabled = !visible.length;
      selectPage.checked = !!visible.length && current === visible.length;
      selectPage.indeterminate = current > 0 && current < visible.length;
      const chosen = filtered.filter((asset) => selected.has(asset.id));
      totals.textContent = `${filtered.length} ${filtered.length === 1 ? 'asset' : 'assets'} · ${bytes(sum(filtered))} | ${chosen.length} selected · ${bytes(sum(chosen))}`;
    }

    function render() {
      const { type, store, references, sort } = Object.fromEntries(
        [...controls.querySelectorAll('select')].map((select) => [select.name, select.value])
      );
      const predicates = [
        [type, (asset) => asset.mediaType === type],
        [store, (asset) => asset.stores.includes(store)],
        [references, (asset) => (references === 'found') === asset.references.length > 0],
      ].flatMap(([value, predicate]) => (value ? [predicate] : []));
      filtered = assets.filter((asset) => predicates.every((matches) => matches(asset))).sort(orders[sort]);
      visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
      body.innerHTML =
        visible.map((asset, index) => row(asset, index, selected, storeNames, esc)).join('') ||
        '<tr><td colspan="6">No assets match.</td></tr>';
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      pageLabel.textContent = `Page ${page + 1} of ${pages}`;
      previous.disabled = page === 0;
      next.disabled = page + 1 >= pages;
      updateSelection();
    }

    controls.addEventListener('change', (event) => {
      if (event.target.name !== 'sort') selected.clear();
      page = 0;
      render();
    });
    previous.onclick = () => {
      page--;
      render();
    };
    next.onclick = () => {
      page++;
      render();
    };
    selectPage.onchange = () => {
      for (const input of body.querySelectorAll('input')) {
        input.checked = selectPage.checked;
        recordSelection(input);
      }
      updateSelection();
    };
    body.onchange = (event) => {
      recordSelection(event.target);
      updateSelection();
    };
    function recordSelection(input) {
      const { id } = visible[Number(input.dataset.assetRow)];
      if (input.checked) selected.add(id);
      else selected.delete(id);
    }
    render();
  }

  function row(asset, index, selected, storeNames, esc) {
    const { id, name, mediaType, stores, observedAt, references } = asset;
    const count = references.length;
    return `<tr>
      <td><input type="checkbox" data-asset-row="${index}" aria-label="Select asset ${esc(name)}"${selected.has(id) ? ' checked' : ''}></td>
      <th scope="row"><code title="${esc(id)}">${esc(name)}</code><br><small>${esc(mediaType)}</small></th>
      <td>${stores.map((store) => esc(storeNames.get(store))).join(', ')}</td>
      <td>${bytes(asset.bytes)}</td><td>${observedAt ? esc(observedAt.slice(0, 10)) : 'Unknown'}</td>
      <td>${count ? `<details><summary>${count} recorded</summary><ul>${references.map((label) => `<li>${esc(label)}</li>`).join('')}</ul></details>` : '0 recorded'}</td>
    </tr>`;
  }
})();
