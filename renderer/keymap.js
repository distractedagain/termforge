import helpers from '../app/keymap.cjs';

const { MENU_ACTIONS, normalizeKeyCombination, keyCombinationForEvent, matchingMapping, decodeMappedText, validateMappings } = helpers;
export { matchingMapping, decodeMappedText };

let installedEditor;
const menuLabels = {
  connect: 'Connect', disconnect: 'Disconnect', reconnect: 'Reconnect', 'local-shell': 'Local Shell', 'quick-connect': 'Quick Connect', find: 'Find', copy: 'Copy', paste: 'Paste', 'select-all': 'Select All', 'clear-screen': 'Clear Screen', 'reset-terminal': 'Reset Terminal', sftp: 'Open SFTP Tab', snapshots: 'Session Snapshots', 'next-tab': 'Next Tab', 'previous-tab': 'Previous Tab', tile: 'Toggle Tiling', 'tile-horizontal': 'Tile Horizontally', 'tile-vertical': 'Tile Vertically', 'tile-grid': 'Tile Grid', 'script-run': 'Run Script',
};

export function installKeymapEditor(container) {
  if (!container || typeof container.append !== 'function' || !container.ownerDocument) throw new Error('A mapped-key editor container is required.');
  installedEditor?.dispose();
  const document = container.ownerDocument;
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  const rows = [];
  let capture, disposed = false;
  container.replaceChildren(); container.classList.add('keymap-editor');
  const help = node('p', 'Map a key to text or a menu action. Text accepts \\r, \\n, \\t, \\e, \\xHH and \\\\ for a literal backslash.'); help.className = 'field-note';
  const wrap = node('div'); wrap.style.overflowX = 'auto';
  const table = node('table'); table.className = 'keymap-table'; table.style.width = '100%'; table.style.minWidth = '480px'; table.style.borderCollapse = 'collapse'; table.setAttribute('aria-label', 'Mapped keys');
  const header = node('thead'); const headings = node('tr');
  for (const title of ['Key combination', 'Action', 'Value', '']) { const cell = node('th', title); cell.scope = 'col'; cell.style.textAlign = 'left'; cell.style.padding = '3px'; headings.append(cell); }
  header.append(headings); const body = node('tbody'); table.append(header, body); wrap.append(table);
  const add = node('button', 'Add mapped key'); add.type = 'button'; add.className = 'secondary-button';
  const status = node('p', ''); status.className = 'field-note'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  container.append(help, wrap, add, status);

  function assertInstalled() { if (disposed) throw new Error('The mapped-key editor has been disposed.'); }
  function refresh() {
    add.disabled = rows.length >= 100;
    rows.forEach((row, index) => {
      row.key.setAttribute('aria-label', `Mapping ${index + 1} key combination`);
      row.action.setAttribute('aria-label', `Mapping ${index + 1} action`);
      row.text.setAttribute('aria-label', `Mapping ${index + 1} text to send`);
      row.menu.setAttribute('aria-label', `Mapping ${index + 1} menu action`);
      row.remove.setAttribute('aria-label', `Remove mapping ${index + 1}`);
    });
  }
  function stopCapture(message) {
    if (!capture) return;
    document.removeEventListener('keydown', capture.listener, true);
    document.removeEventListener('visibilitychange', capture.visibility);
    capture.button.removeEventListener('blur', capture.blur);
    capture.dialog?.removeEventListener('close', capture.close);
    capture.dialog?.removeEventListener('cancel', capture.close);
    capture.button.textContent = 'Capture'; capture.button.setAttribute('aria-pressed', 'false');
    capture = null;
    if (message !== undefined) status.textContent = message;
  }
  function beginCapture(row) {
    if (disposed) return;
    if (capture?.button === row.capture) { stopCapture('Key capture cancelled.'); return; }
    stopCapture();
    row.capture.focus(); row.capture.textContent = 'Choosing…'; row.capture.setAttribute('aria-pressed', 'true');
    status.textContent = 'Press the key combination. Escape cancels; enter Escape manually if you want to map it.';
    const listener = event => {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { stopCapture('Key capture cancelled.'); return; }
      const combination = keyCombinationForEvent(event);
      if (!combination) {
        if (!['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(event.key)) status.textContent = 'That key is not supported. Choose a letter, digit, function or navigation key, or press Escape to cancel.';
        return;
      }
      row.key.value = combination; row.key.setCustomValidity('');
      stopCapture(`Captured ${combination}.`); row.key.focus();
    };
    const blur = () => stopCapture('Key capture cancelled.');
    const close = () => stopCapture();
    const visibility = () => { if (document.hidden) stopCapture('Key capture cancelled.'); };
    capture = { button: row.capture, listener, blur, close, visibility, dialog: container.closest('dialog') };
    document.addEventListener('keydown', listener, true);
    document.addEventListener('visibilitychange', visibility);
    row.capture.addEventListener('blur', blur);
    capture.dialog?.addEventListener('close', close);
    capture.dialog?.addEventListener('cancel', close);
  }
  function addRow(mapping = { key: '', action: 'send', value: '' }) {
    assertInstalled();
    if (rows.length >= 100) throw new Error('Mapped keys must contain at most 100 mappings.');
    const row = { element: node('tr') };
    const keyCell = node('td'), keyWrap = node('div'); keyWrap.style.display = 'flex'; keyWrap.style.gap = '3px';
    row.key = node('input'); row.key.type = 'text'; row.key.maxLength = 100; row.key.placeholder = 'Ctrl+Alt+F1'; row.key.value = mapping.key; row.key.style.minWidth = '110px'; row.key.style.width = '140px'; row.key.spellcheck = false; row.key.dataset.field = 'key';
    row.capture = node('button', 'Capture'); row.capture.type = 'button'; row.capture.setAttribute('aria-pressed', 'false'); row.capture.addEventListener('click', () => beginCapture(row));
    row.key.addEventListener('blur', () => { if (row.key.value.trim()) try { row.key.value = normalizeKeyCombination(row.key.value); row.key.setCustomValidity(''); } catch (error) { row.key.setCustomValidity(error.message); } });
    row.key.addEventListener('input', () => row.key.setCustomValidity(''));
    keyWrap.append(row.key, row.capture); keyCell.append(keyWrap);
    const actionCell = node('td'); row.action = node('select'); row.action.dataset.field = 'action';
    for (const [value, label] of [['send', 'Send text'], ['menu', 'Menu action']]) { const option = node('option', label); option.value = value; row.action.append(option); }
    row.action.value = mapping.action; actionCell.append(row.action);
    const valueCell = node('td'); row.text = node('textarea'); row.text.rows = 2; row.text.maxLength = 16384; row.text.spellcheck = false; row.text.placeholder = 'show version\\r'; row.text.value = mapping.action === 'send' ? mapping.value : ''; row.text.style.minWidth = '160px'; row.text.style.width = '100%'; row.text.dataset.field = 'send-value';
    row.menu = node('select'); row.menu.dataset.field = 'menu-value'; const placeholder = node('option', 'Choose menu action'); placeholder.value = ''; row.menu.append(placeholder);
    for (const value of MENU_ACTIONS) { const option = node('option', menuLabels[value] || value); option.value = value; row.menu.append(option); }
    row.menu.value = mapping.action === 'menu' ? mapping.value : ''; valueCell.append(row.text, row.menu);
    const showValue = () => { row.text.hidden = row.action.value !== 'send'; row.menu.hidden = row.action.value !== 'menu'; };
    row.action.addEventListener('change', showValue); showValue();
    const removeCell = node('td'); row.remove = node('button', '×'); row.remove.type = 'button'; row.remove.className = 'icon-button';
    row.remove.addEventListener('click', () => { if (capture?.button === row.capture) stopCapture(); rows.splice(rows.indexOf(row), 1); row.element.remove(); refresh(); });
    removeCell.append(row.remove);
    for (const cell of [keyCell, actionCell, valueCell, removeCell]) { cell.style.padding = '3px'; cell.style.verticalAlign = 'top'; row.element.append(cell); }
    body.append(row.element); rows.push(row); refresh(); return row;
  }
  const onAdd = () => { if (!disposed) addRow().key.focus(); };
  add.addEventListener('click', onAdd);
  const controller = {
    loadMappings(mappings) {
      assertInstalled(); const validated = validateMappings(mappings);
      stopCapture(); rows.splice(0); body.replaceChildren(); status.textContent = '';
      for (const mapping of validated) addRow(mapping);
      refresh();
    },
    readMappings() {
      assertInstalled(); stopCapture();
      const values = rows.map(row => ({ key: row.key.value, action: row.action.value, value: row.action.value === 'send' ? row.text.value : row.menu.value }));
      try {
        const result = validateMappings(values);
        result.forEach((mapping, index) => { rows[index].key.value = mapping.key; rows[index].key.setCustomValidity(''); });
        status.textContent = ''; return result;
      } catch (error) { status.textContent = error.message; throw error; }
    },
    dispose() {
      if (disposed) return;
      stopCapture(); add.removeEventListener('click', onAdd); disposed = true; container.replaceChildren();
      if (installedEditor === controller) installedEditor = null;
    },
  };
  installedEditor = controller; refresh(); return controller;
}

export function loadMappings(mappings) {
  if (!installedEditor) throw new Error('Install the mapped-key editor before loading mappings.');
  installedEditor.loadMappings(mappings);
}

export function readMappings() {
  if (!installedEditor) throw new Error('Install the mapped-key editor before reading mappings.');
  return installedEditor.readMappings();
}
