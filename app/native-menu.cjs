'use strict';
const { buildMenus, sanitizeMenuState, findMenuAction, NATIVE_ACTIONS } = require('./menu-model.cjs');

// Electron is injected so the menu lifecycle can be checked without starting an
// application or touching a real keychain, clipboard or terminal.
function createNativeMenu({ Menu, platform = process.platform, appName = 'ForgeCRT', dispatch, runNative, getContext = () => ({}), onError = () => {} }) {
  if (!Menu || typeof Menu.buildFromTemplate !== 'function' || typeof Menu.setApplicationMenu !== 'function' || typeof dispatch !== 'function') throw new TypeError('Native menu dependencies are required.');
  let state = sanitizeMenuState(), signature = '', menus = [], disposed = false;
  function snapshot() {
    const context = getContext() || {};
    // Trusted main-process focus and readiness override the renderer snapshot.
    const focusedState = { ...state };
    for (const key of ['ready', 'dialogOpen', 'quickConnectFocused']) if (typeof context[key] === 'boolean') focusedState[key] = context[key];
    return buildMenus(focusedState, platform);
  }
  function execute(action) {
    if (disposed) return false;
    const current = findMenuAction(snapshot(), action);
    if (!current?.enabled) return false;
    try {
      const result = NATIVE_ACTIONS.has(action) ? runNative?.(action) : dispatch(action);
      Promise.resolve(result).catch(onError);
      return true;
    } catch (error) { onError(error); return false; }
  }
  function template(entries) {
    return entries.map(entry => {
      if (!entry) return { type: 'separator' };
      // On Windows/Linux Electron interprets ampersands as mnemonics.
      const label = platform === 'darwin' ? entry.label : entry.label.replace(/&/g, '&&');
      const result = { label: entry.unavailableReason ? `${label} — unavailable` : label, enabled: entry.submenu ? entry.enabled !== false : Boolean(entry.enabled) };
      if (entry.unavailableReason) result.toolTip = entry.unavailableReason;
      if (entry.submenu) result.submenu = template(entry.submenu);
      else {
        if (typeof entry.checked === 'boolean') { result.type = 'checkbox'; result.checked = entry.checked; }
        if (entry.action) result.click = () => execute(entry.action);
        if (entry.accelerator) result.accelerator = entry.accelerator;
      }
      return result;
    });
  }
  function refresh() {
    if (disposed) return false;
    const next = snapshot(), nextSignature = JSON.stringify(next);
    if (signature === nextSignature) return false;
    const appMenu = platform === 'darwin' ? [{ label: appName, submenu: [
      { role: 'about', label: `About ${appName}` }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide', label: `Hide ${appName}` }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: `Quit ${appName}` }
    ] }] : [];
    const built = Menu.buildFromTemplate([...appMenu, ...template(next)]);
    Menu.setApplicationMenu(built);
    signature = nextSignature; menus = next;
    return true;
  }
  function update(input) {
    if (disposed) return false;
    state = sanitizeMenuState(input);
    return refresh();
  }
  return { update, refresh, execute, current: () => structuredClone(menus), dispose: () => { disposed = true; menus = []; signature = ''; } };
}

module.exports = { createNativeMenu };
