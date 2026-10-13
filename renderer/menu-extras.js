const $ = id => document.getElementById(id);
export function createMenuExtras({ api, toast, confirmAction, getCurrent, getConnections, openConnection, onChange = () => {} }) {
  const content = document.createElement('div');
  content.innerHTML = `<dialog id="page-setup-dialog" class="modal"><header class="modal-header"><h2>Page Setup</h2><button class="icon-button dialog-close" aria-label="Close">×</button></header><div class="modal-body"><label>Paper size<select id="print-paper"><option>Letter</option><option>A4</option><option>Legal</option></select></label><label class="option-check"><input type="checkbox" id="print-landscape">Landscape</label><p class="field-note">Applies to terminal text printed from TermForge. Choose the printer or Save as PDF in the system print dialog.</p></div><footer class="modal-footer"><button id="page-setup-save" class="primary-button">Save</button></footer></dialog>
  <dialog id="opacity-dialog" class="modal"><header class="modal-header"><h2>Window Transparency</h2><button class="icon-button dialog-close" aria-label="Close">×</button></header><div class="modal-body"><label>Opacity <output id="opacity-value">100%</output><input type="range" id="window-opacity" min="50" max="100" step="5" value="100"></label></div><footer class="modal-footer"><button id="opacity-apply" class="primary-button">Apply</button></footer></dialog>
  <dialog id="hex-dialog" class="modal"><header class="modal-header"><h2>Hex View</h2><button class="icon-button dialog-close" aria-label="Close">×</button></header><div class="modal-body"><p id="hex-caption" class="field-note"></p><pre id="hex-data" class="hex-data" tabindex="0"></pre></div><footer class="modal-footer"><button id="hex-refresh" class="secondary-button">Refresh</button></footer></dialog>
  <dialog id="menu-availability-dialog" class="modal"><header class="modal-header"><h2>Menu Feature Availability</h2><button class="icon-button dialog-close" aria-label="Close">×</button></header><div class="modal-body"><p>Commands enable when their required session, selection, or operation is available. Hover an unavailable in-app command for its reason.</p><p>Implemented: session and snapshot actions, clipboard/focus/clear controls, view controls, text printing, text/raw logging and ASCII capture, supported binary sends, script run/record/cancel, SSH key generation/conversion, credential and host management, settings import/export, CSV/TSV session import, reviewed SFTP file management, and tab groups.</p><p>Still unavailable: Kermit/Xmodem/Ymodem/Zmodem, live-tab detachment, cascade windows, session locking, full XML settings import, an SSH public-key installation assistant, configuration master passwords, and protocol tracing. Automatic settings save remains always on. OpenSSH key formats and OS-protected credentials follow TermForge's own documented behavior.</p><p>Binary sending and byte-based Hex View require a supported transport; system OpenSSH and local PTYs provide decoded terminal output. Printing opens your operating system's print dialog. Help → Updates opens the release page.</p></div></dialog>`;
  document.body.append(...content.children);
  let pageSetup = { pageSize: 'Letter', landscape: false }, opacity = 1, hexTarget = null;
  try { const saved = JSON.parse(localStorage.getItem('termforge-page-setup') || 'null'); if (saved && ['Letter','A4','Legal'].includes(saved.pageSize)) pageSetup = { pageSize:saved.pageSize, landscape:saved.landscape === true }; } catch {}
  const show = id => { if (!$(id).open) $(id).showModal(); };
  const attempt = fn => Promise.resolve().then(fn).catch(error => toast(error.message || String(error), true));
  $('page-setup-save').onclick = () => { pageSetup = { pageSize: $('print-paper').value, landscape: $('print-landscape').checked }; try { localStorage.setItem('termforge-page-setup', JSON.stringify(pageSetup)); } catch {} $('page-setup-dialog').close(); };
  $('window-opacity').oninput = () => { $('opacity-value').textContent = `${$('window-opacity').value}%`; };
  $('opacity-apply').onclick = () => attempt(async () => { const next = Number($('window-opacity').value) / 100; await api.desktopAction('window-transparency', next); opacity = next; $('opacity-dialog').close(); });
  async function refreshHex() {
    if (!hexTarget) return;
    const result = await api.terminalReadRaw(hexTarget.id);
    const bytes = [...atob(result.base64 || '')].map(char => char.charCodeAt(0)), start = result.offset || 0;
    const lines = [];
    for (let index = 0; index < bytes.length; index += 16) {
      const part = bytes.slice(index, index + 16);
      lines.push((start + index).toString(16).padStart(8, '0') + '  ' + part.map(value => value.toString(16).padStart(2, '0')).join(' ').padEnd(47) + '  ' + part.map(value => value >= 32 && value < 127 ? String.fromCharCode(value) : '.').join(''));
    }
    $('hex-caption').textContent = `${hexTarget.title} · latest ${bytes.length} received bytes (up to 64 KiB). Refresh to update.`;
    $('hex-data').textContent = lines.join('\n') || 'No bytes received yet.';
  }
  $('hex-refresh').onclick = () => attempt(refreshHex);
  async function print(action, current) {
    if (!current) return;
    await new Promise(resolve => current.term.write('', resolve));
    const buffer = current.term.buffer.active;
    let text = action === 'print-selection' ? current.term.getSelection() : '';
    if (action !== 'print-selection') {
      const first = action === 'print-screen' ? buffer.viewportY : 0;
      const last = action === 'print-screen' ? Math.min(buffer.length, first + current.term.rows) : buffer.length;
      const lines = []; let bytes = 0;
      for (let row = first; row < last; row++) {
        const line = buffer.getLine(row)?.translateToString(true) || '';
        bytes += new TextEncoder().encode(line).length + 1;
        if (bytes > 2 * 1024 * 1024) throw new Error('This scrollback exceeds the 2 MiB printing limit. Select a smaller section to print.');
        lines.push(line);
      }
      text = lines.join('\n');
    }
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('Select no more than 2 MiB of text to print.');
    const accepted = await confirmAction({ title:'Print terminal text?', message:`Print text from “${current.title}”. Review it before sending to a printer or saving as PDF.`, preview:text, accept:'Open print dialog' });
    if (accepted) await api.printTerminal({ title:current.title, text, ...pageSetup });
  }
  async function perform(action) {
    const current = getCurrent();
    if (['minimize-window','zoom-window','close-window','toggle-fullscreen','bring-all-front','help-web','help-updates','help-support'].includes(action)) { await api.desktopAction(action); return true; }
    if (['print-selection','print-screen','print-scrollback'].includes(action)) { await print(action, current); return true; }
    switch (action) {
      case 'feature-availability': show('menu-availability-dialog'); return true;
      case 'page-setup': $('print-paper').value = pageSetup.pageSize; $('print-landscape').checked = pageSetup.landscape; show('page-setup-dialog'); return true;
      case 'window-transparency': $('window-opacity').value = Math.round(opacity * 100); $('opacity-value').textContent = `${Math.round(opacity * 100)}%`; show('opacity-dialog'); return true;
      case 'hex-view': if (current) { hexTarget = { id:current.id,title:current.title }; await refreshHex(); show('hex-dialog'); } return true;
      case 'disconnect-all': case 'reconnect-all': {
        const targets = [...getConnections().values()].filter(c => action === 'disconnect-all' ? !c.exited : !c.reconnecting);
        if (!targets.length || !await confirmAction({ title: action === 'disconnect-all' ? 'Disconnect all sessions?' : 'Reconnect all sessions?', message: 'Running programs may be interrupted. Review the sessions below.', targets: targets.map(c => c.title), accept: action === 'disconnect-all' ? 'Disconnect all' : 'Reconnect all' })) return true;
        const errors = [];
        const reconnecting = action === 'reconnect-all';
        for (const target of targets) if (reconnecting) target.reconnecting = true;
        onChange();
        for (const target of targets) {
          try {
            if (getConnections().get(target.id) !== target) continue;
            if (!target.exited) await api.terminalClose(target.id);
            if (reconnecting) await openConnection(target.profile, target.id);
          } catch (error) { errors.push(`${target.title}: ${error.message}`); }
          finally { if (reconnecting) target.reconnecting = false; onChange(); }
        }
        if (errors.length) toast(errors.join('; '), true);
        return true;
      }
      case 'receive-ascii': {
        if (!current || current.exited) return true;
        const enabled = !current.outputState?.capture?.enabled;
        if (enabled && !await confirmAction({ title:'Receive ASCII to a file?', message:`Capture incoming decoded text from “${current.title}” to a new local file until you stop receiving. Escape sequences are removed; this is not a file-transfer protocol. Output may contain sensitive information.`, accept:'Choose capture file' })) return true;
        await api.terminalSetCapture({ id:current.id, enabled }); return true;
      }
      case 'send-binary': if (current && !current.exited) await api.terminalSendBinary(current.id); return true;
      case 'raw-log': {
        if (!current || current.exited) return true;
        const enabled = !(current.logging && current.outputState?.log?.mode === 'raw');
        if (enabled && !await confirmAction({ title:'Start raw logging?', message:`Save received bytes from “${current.title}” to a new local file, including control sequences. Output may contain sensitive information.`, accept:'Choose raw log file' })) return true;
        const result = await api.terminalSetLog({ id:current.id, enabled, mode:'raw' });
        if (result.canceled) return true;
        current.logging = !!result.enabled; current.logPaused = false; return true;
      }
      default: return false;
    }
  }
  return { perform };
}
