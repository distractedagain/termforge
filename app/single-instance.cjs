'use strict';

// Recovery journals are owned by one application process. A later launch can
// bring the existing window forward, but never forwards commands or file paths.
function claimApplicationInstance(app, getWindow) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  let pendingFocus = false;
  function focusMainWindow() {
    const window = getWindow();
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    pendingFocus = false;
    return true;
  }
  app.on('second-instance', () => {
    pendingFocus = true;
    focusMainWindow();
  });
  app.on('browser-window-created', () => {
    if (!pendingFocus) return;
    // Electron emits during construction, before `window = new BrowserWindow`
    // assigns the owner's reference. Always use that reference, never an
    // arbitrary child window supplied with this event.
    queueMicrotask(() => { if (pendingFocus) focusMainWindow(); });
  });
  return true;
}

module.exports = { claimApplicationInstance };
