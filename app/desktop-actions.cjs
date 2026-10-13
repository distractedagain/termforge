'use strict';

const HELP_URLS = Object.freeze({
  'help-web': 'https://github.com/distractedagain/termforge',
  'help-updates': 'https://github.com/distractedagain/termforge/releases',
  'help-support': 'https://github.com/distractedagain/termforge/issues',
});
const escapeHtml = text => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
function printDocument(input) {
  if (!input || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 2 * 1024 * 1024 || !input.text.trim()) throw new Error('Choose up to 2 MiB of terminal text to print.');
  const title = typeof input.title === 'string' ? input.title.slice(0, 200) : 'ForgeCRT';
  const pageSize = ['A4', 'Letter', 'Legal'].includes(input.pageSize) ? input.pageSize : 'Letter';
  const landscape = input.landscape === true;
  return { html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>body{color:#000;background:#fff;font:11px monospace}h1{font:14px sans-serif}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(input.text)}</pre></body></html>`, options: { silent: false, printBackground: false, landscape, pageSize, margins: { marginType: 'default' } } };
}
function createDesktopActions({ BrowserWindow, shell, getWindow, getActionWindow = getWindow, platform = process.platform }) {
  let printing = false;
  return {
    async perform(action, value) {
      const window = getActionWindow();
      if (!window || window.isDestroyed()) throw new Error('The workspace is closed.');
      if (Object.hasOwn(HELP_URLS, action)) { await shell.openExternal(HELP_URLS[action]); return true; }
      switch (action) {
        case 'minimize-window': window.minimize(); break;
        case 'zoom-window': if (window.isMaximized()) window.unmaximize(); else window.maximize(); break;
        case 'close-window': window.close(); break;
        case 'toggle-fullscreen': window.setFullScreen(!window.isFullScreen()); break;
        case 'bring-all-front': for (const item of BrowserWindow.getAllWindows()) if (!item.isDestroyed() && item.isVisible()) { if (item.isMinimized()) item.restore(); item.show(); } window.focus(); break;
        case 'window-transparency':
          if (!['darwin', 'win32'].includes(platform)) throw new Error('Window transparency is available on macOS and Windows.');
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 1) throw new Error('Opacity must be between 50% and 100%.');
          window.setOpacity(value); break;
        default: throw new Error('Unknown desktop command.');
      }
      return window.isDestroyed() ? { closed: true } : { fullScreen: window.isFullScreen(), opacity: window.getOpacity() };
    },
    async print(input) {
      const document = printDocument(input);
      if (printing) throw new Error('Finish the current print dialog first.');
      printing = true;
      let printWindow;
      try {
        printWindow = new BrowserWindow({ show: false, parent: getWindow(), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
        printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        printWindow.webContents.on('will-navigate', event => event.preventDefault());
        await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document.html)}`);
        return await new Promise((resolve, reject) => {
          printWindow.once('closed', () => reject(new Error('Printing window was closed.')));
          printWindow.webContents.print(document.options, (success, reason) => {
            if (success) resolve({ printed: true });
            else if (/cancel/i.test(reason || '')) resolve({ printed: false, canceled: true });
            else reject(new Error(reason || 'The print request failed.'));
          });
        });
      } finally { printing = false; if (printWindow && !printWindow.isDestroyed()) printWindow.destroy(); }
    },
  };
}
module.exports = { createDesktopActions, printDocument, HELP_URLS };
