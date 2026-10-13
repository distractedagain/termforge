import './session-import.css';
const element = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
const fields = [['host', 'Host (required)'], ['name', 'Session name'], ['protocol', 'Protocol'], ['port', 'Port'], ['username', 'Username'], ['folder', 'Folder'], ['description', 'Description']];
export function createSessionImportUi({ api, toast = () => {}, onImported = async () => {} }) {
  let file = null, plan = null, busy = false, rows = [], selectedRows, revision = 0;
  const dialog = element('dialog', 'modal session-import-modal'); dialog.id = 'session-import-dialog'; dialog.setAttribute('aria-labelledby', 'session-import-title');
  const header = element('header', 'modal-header'); const heading = element('h2', '', 'Import sessions from text'); heading.id = 'session-import-title'; const close = element('button', 'icon-button', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close session import'); header.append(heading, close);
  const body = element('div', 'modal-body'); const note = element('p', 'field-note', 'Import SSH2, SFTP, Telnet or Raw connection metadata from UTF-8 CSV/TSV files. Review the mapped fields and selected rows before saving. Passwords, keys and credential references are not imported. No connection opens automatically.');
  const source = element('p', 'session-import-source'); source.id = 'session-import-source';
  const controls = element('div', 'session-import-controls');
  function select(id, label, options) { const wrapper = element('label', '', label); const input = element('select'); input.id = id; for (const [value, title] of options) { const option = element('option', '', title); option.value = value; input.append(option); } wrapper.append(input); controls.append(wrapper); return input; }
  const delimiter = select('session-import-delimiter', 'Delimiter', [['comma','Comma (CSV)'],['tab','Tab (TSV)'],['semicolon','Semicolon']]);
  const collision = select('session-import-collision', 'Matching folder and name', [['skip','Skip duplicates'],['rename','Import with a unique name'],['replace','Replace saved settings (keep ID)']]);
  const headerLabel = element('label', 'option-check'); const hasHeader = element('input'); hasHeader.type = 'checkbox'; hasHeader.id = 'session-import-header'; headerLabel.append(hasHeader, element('span', '', 'First row contains column names')); controls.append(headerLabel);
  const warning = element('p', 'field-note', 'Replace resets all session options to the imported values and defaults, and clears saved credential references. Existing session IDs stay the same. Matching ignores letter case.'); warning.id = 'session-import-replace-note'; warning.hidden = true;
  const mapping = element('div', 'session-import-mapping'); const inputs = new Map();
  for (const [field, label] of fields) { const wrapper = element('label', '', label); const input = element('select'); input.id = `session-import-map-${field}`; wrapper.append(input); mapping.append(wrapper); inputs.set(field,input); input.addEventListener('change', () => invalidate(true)); }
  const actions = element('div', 'session-import-preview-actions'); const preview = element('button', 'secondary-button', 'Preview import'); preview.type = 'button'; preview.id = 'session-import-preview'; const valid = element('button', 'quiet-button', 'Select valid rows'); valid.type = 'button'; valid.id = 'session-import-valid'; actions.append(preview, valid);
  const summary = element('p', 'field-note'); summary.id = 'session-import-summary'; summary.setAttribute('role','status');
  const tableWrap = element('div', 'session-import-table-wrap'); tableWrap.tabIndex = 0; tableWrap.setAttribute('aria-label','Session import preview');
  const table = element('table', 'session-import-table'); const thead = element('thead'); const headRow = element('tr'); for (const title of ['Import','Line','Session / folder','Connection','Username','Result']) headRow.append(element('th','',title)); thead.append(headRow); const tbody = element('tbody'); tbody.id = 'session-import-rows'; table.append(thead,tbody); tableWrap.append(table);
  const error = element('p', 'form-error'); error.id = 'session-import-error'; error.hidden = true; error.setAttribute('role','alert');
  body.append(note,source,controls,warning,mapping,actions,summary,tableWrap,error);
  const footer = element('footer','modal-footer'); const cancel = element('button','quiet-button','Cancel'); cancel.type = 'button'; cancel.id = 'session-import-cancel'; const apply = element('button','primary-button','Import selected sessions'); apply.type = 'button'; apply.id = 'session-import-apply'; footer.append(cancel,apply); dialog.append(header,body,footer); document.body.append(dialog);
  const fail = exception => { error.textContent = exception?.message || String(exception); error.hidden = false; };
  function setBusy(value) { busy = value; controls.inert = mapping.inert = tableWrap.inert = value; close.disabled = cancel.disabled = value; preview.disabled = value || !file; valid.disabled = value || !rows.length; apply.disabled = value || !plan; dialog.setAttribute('aria-busy',String(value)); }
  function invalidate(clear = false) { revision++; plan = null; error.hidden = true; summary.textContent = 'Options changed. Preview again before importing.'; if (clear) { rows = []; selectedRows = undefined; tbody.replaceChildren(); } warning.hidden = collision.value !== 'replace'; setBusy(busy); }
  function mapColumns(columns, values = {}) {
    for (const [field,input] of inputs) { const ignored = element('option','','Not imported'); ignored.value = ''; input.replaceChildren(ignored); for (const column of columns) { const option = element('option','',`${column.index + 1}: ${column.label}${column.sensitive ? ' (protected — ignored)' : ''}`); option.value = String(column.index); option.disabled = column.sensitive; input.append(option); } input.value = values[field] === undefined ? '' : String(values[field]); }
  }
  function request() { const mapping = {}; for (const [field,input] of inputs) if (input.value !== '') mapping[field] = Number(input.value); return {fileId:file.fileId,delimiter:delimiter.value,header:hasHeader.checked,collision:collision.value,mapping,...(selectedRows === undefined ? {} : {selectedRows})}; }
  function renderRows() {
    tbody.replaceChildren();
    for (const row of rows) {
      const tr = element('tr', row.status === 'error' ? 'session-import-invalid' : ''); const checkCell = element('td'); const check = element('input'); check.type = 'checkbox'; check.checked = row.selected; check.dataset.row = row.row; check.setAttribute('aria-label',`Import line ${row.row}`); check.addEventListener('change', () => { row.selected = check.checked; selectedRows = rows.filter(item => item.selected).map(item => item.row); invalidate(); }); checkCell.append(check);
      const name = element('td'); name.append(element('strong','',row.name || 'Invalid row')); if (row.folder) name.append(element('small','',row.folder));
      if (row.description) { const details = element('details'); details.append(element('summary','','Description'),element('p','',row.description)); name.append(details); }
      const result = element('td'); result.append(element('strong','',row.selected ? row.status : 'excluded'),element('small','',row.message));
      tr.append(checkCell,element('td','',row.row),name,element('td','',row.host ? `${row.protocol.toUpperCase()} · ${row.host}:${row.port}` : '—'),element('td','',row.username || '—'),result); tbody.append(tr);
    }
  }
  async function showPreview() {
    if (busy || !file) return; const token = revision; setBusy(true); error.hidden = true; plan = null;
    try { const result = await api.sessionImportPreview(request()); if (token !== revision) return; rows = result.rows; plan = result.canApply ? result.planId : null; renderRows(); const c = result.counts; summary.textContent = `${c.added} added · ${c.replaced} replaced · ${c.skipped} skipped · ${c.excluded} excluded · ${c.errors} errors. ${result.message || (result.canApply ? 'Review the selected rows, then import.' : 'Correct mappings or explicitly exclude invalid rows, then preview again.')}`; }
    catch (exception) { fail(exception); }
    finally { setBusy(false); }
  }
  async function changeFormat() {
    if (busy || !file) return; invalidate(true); setBusy(true);
    try { const result = await api.sessionImportPreview({...request(),mapping:{}}); mapColumns(result.columns,result.suggestedMapping); summary.textContent = `${result.rowCount} data rows. Map the columns and preview the import.`; }
    catch (exception) { mapColumns([]); fail(exception); }
    finally { setBusy(false); }
  }
  delimiter.addEventListener('change',changeFormat); hasHeader.addEventListener('change',changeFormat); collision.addEventListener('change',() => invalidate(true)); preview.addEventListener('click',showPreview);
  valid.addEventListener('click',() => { if (busy) return; for (const row of rows) row.selected = row.status !== 'error'; selectedRows = rows.filter(row => row.selected).map(row => row.row); renderRows(); invalidate(); });
  async function discard() { const chosen = file; file = null; plan = null; rows = []; selectedRows = undefined; revision++; tbody.replaceChildren(); source.textContent = ''; for (const input of inputs.values()) input.replaceChildren(); if (chosen) { try { await api.sessionImportDiscard({fileId:chosen.fileId}); } catch { /* Main-process expiry also releases abandoned previews. */ } } }
  async function dismiss() { if (busy) return; dialog.close(); await discard(); }
  close.addEventListener('click',dismiss); cancel.addEventListener('click',dismiss); dialog.addEventListener('cancel',event => { event.preventDefault(); dismiss(); });
  // A queued close event from a previous opening may arrive after reopening.
  // Only clean up the currently closed dialog, never a newly selected import.
  dialog.addEventListener('close',() => { if (!busy && !dialog.open) void discard(); });
  dialog.addEventListener('click',event => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void dismiss(); });
  apply.addEventListener('click',async () => {
    if (busy || !plan) return; const planId = plan; plan = null; setBusy(true); error.hidden = true;
    try {
      const result = await api.sessionImportApply({planId});
      if (result.canceled) { summary.textContent = 'Import canceled. Preview again to review and save.'; return; }
      await discard(); dialog.close(); toast(`${result.added} sessions imported, ${result.replaced} replaced.`);
      try { await onImported(result); } catch { toast('Sessions were saved, but the session list could not refresh. Restart TermForge after finishing your active work.', true); }
    } catch (exception) { fail(exception); summary.textContent = 'Preview again before importing.'; }
    finally { setBusy(false); }
  });
  async function open() {
    if (busy) { if (!dialog.open) dialog.showModal(); return; }
    setBusy(true); await discard(); error.hidden = true; summary.textContent = 'Choose a UTF-8 session list.'; collision.value = 'skip'; warning.hidden = true; if (!dialog.open) dialog.showModal(); setBusy(true);
    try {
      const result = await api.sessionImportChoose();
      if (result.canceled) { dialog.close(); return; }
      file = result; source.textContent = `${result.name} · ${result.rowCount} data rows`; delimiter.value = result.delimiter; hasHeader.checked = result.header; mapColumns(result.columns,result.suggestedMapping); summary.textContent = 'Review the column mapping, then preview the import.';
    } catch (exception) { fail(exception); }
    finally { setBusy(false); if (file) inputs.get('host').focus(); }
  }
  setBusy(false); return { open };
}
