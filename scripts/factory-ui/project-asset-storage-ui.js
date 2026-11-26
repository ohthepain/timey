(() => {
  'use strict';
  const batchSize = 25;
  const numberFormat = new Intl.NumberFormat();
  const bytes = (size) => numberFormat.format(size) + ' bytes';
  const orders = {
    name: (a, b) => a.name.localeCompare(b.name),
    size: (a, b) => a.bytes - b.bytes,
    date: (a, b) => (a.observedAt || '').localeCompare(b.observedAt || ''),
    references: (a, b) => a.references.length - b.references.length,
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
          <option value="references">Recorded reference count</option>
        </select></label>
        <label>Sort direction <select name="direction">
          <option value="asc">Ascending</option><option value="desc">Descending</option>
        </select></label>
      </div>
      <div data-asset-selection>
        <label><input type="checkbox" data-asset-select-visible> Select all (visible)</label>
        <label><input type="checkbox" data-asset-select-matches> Select all matches</label>
      </div>
      <p data-asset-totals role="status"></p>
      <div data-asset-table tabindex="0" role="region" aria-label="Project assets">
        <table>
          <thead><tr><th scope="col" aria-label="Selection"></th>
          <th scope="col">Asset</th><th scope="col">Store</th><th scope="col">Size</th>
          <th scope="col">Object date</th><th scope="col">References</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>`;
    initializeTable(container, assets, storeNames, esc);
  };

  function initializeTable(container, assets, storeNames, esc) {
    const selected = new Map();
    const controls = container.querySelector('[data-asset-filters]');
    const selectVisible = container.querySelector('[data-asset-select-visible]');
    const selectMatches = container.querySelector('[data-asset-select-matches]');
    const table = container.querySelector('[data-asset-table]');
    const body = container.querySelector('tbody');
    const totals = container.querySelector('[data-asset-totals]');
    let filtered = [];
    let filteredBytes = 0;
    let loadedCount = 0;

    function updateBulkControls() {
      let loadedSelected = 0;
      for (let index = 0; index < loadedCount; index++) {
        loadedSelected += Number(selected.has(filtered[index].id));
      }
      updateBulkCheckbox(selectVisible, loadedCount, loadedSelected);
      updateBulkCheckbox(selectMatches, filtered.length, selected.size);
    }

    function updateTotals() {
      let selectedBytes = 0;
      for (const size of selected.values()) selectedBytes += size;
      totals.textContent = `${filtered.length} ${filtered.length === 1 ? 'asset' : 'assets'} · ${bytes(filteredBytes)} | ${selected.size} selected · ${bytes(selectedBytes)}`;
    }

    function appendBatch() {
      const batch = filtered.slice(loadedCount, loadedCount + batchSize);
      body.insertAdjacentHTML(
        'beforeend',
        batch.map((asset, index) => row(asset, loadedCount + index, selected, storeNames, esc)).join('')
      );
      loadedCount += batch.length;
      updateBulkControls();
    }

    function render() {
      const { type, store, references, sort, direction } = Object.fromEntries(
        [...controls.querySelectorAll('select')].map((select) => [select.name, select.value])
      );
      const predicates = [
        [type, (asset) => asset.mediaType === type],
        [store, (asset) => asset.stores.includes(store)],
        [references, (asset) => (references === 'found') === asset.references.length > 0],
      ].flatMap(([value, predicate]) => (value ? [predicate] : []));
      const order = direction === 'desc' ? -1 : 1;
      filtered = assets
        .filter((asset) => predicates.every((matches) => matches(asset)))
        .sort((a, b) => order * orders[sort](a, b) || orders.name(a, b));
      filteredBytes = filtered.reduce((total, asset) => total + asset.bytes, 0);
      loadedCount = 0;
      table.scrollTop = 0;
      body.innerHTML = filtered.length ? '' : '<tr><td colspan="6">No assets match.</td></tr>';
      appendBatch();
      updateTotals();
    }

    controls.addEventListener('change', (event) => {
      if (event.target.name !== 'sort' && event.target.name !== 'direction') selected.clear();
      render();
    });
    table.addEventListener('scroll', () => {
      const remaining = table.scrollHeight - table.scrollTop - table.clientHeight;
      if (loadedCount < filtered.length && remaining <= 48) appendBatch();
    });
    selectVisible.onchange = () => selectRows(loadedCount, selectVisible.checked);
    selectMatches.onchange = () => selectRows(filtered.length, selectMatches.checked);
    body.onchange = ({ target }) => {
      recordSelection(filtered[Number(target.dataset.assetRow)], target.checked);
      updateBulkControls();
      updateTotals();
    };

    function selectRows(count, checked) {
      for (let index = 0; index < count; index++) recordSelection(filtered[index], checked);
      for (const input of body.querySelectorAll('[data-asset-row]')) {
        input.checked = selected.has(filtered[Number(input.dataset.assetRow)].id);
      }
      updateBulkControls();
      updateTotals();
    }

    function recordSelection(asset, checked) {
      if (checked) selected.set(asset.id, asset.bytes);
      else selected.delete(asset.id);
    }
    render();
  }

  function updateBulkCheckbox(input, count, checked) {
    input.disabled = count === 0;
    input.checked = count > 0 && checked === count;
    input.indeterminate = checked > 0 && checked < count;
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
