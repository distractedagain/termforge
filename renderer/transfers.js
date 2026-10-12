const $ = id => document.getElementById(id);
export function createTransferUi({ api }) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<dialog id="tftp-dialog" class="modal"><header class="modal-header"><h2>TFTP Server</h2><button type="button" class="icon-button dialog-close" aria-label="Close">×</button></header><div class="modal-body"><p class="field-note">TFTP transfers are unencrypted. Only the specified client IP can access this shared folder. Uploads create new files; existing files are never replaced.</p><label>Shared folder<div class="input-button"><input id="tftp-root" readonly placeholder="Choose a folder…"><button id="tftp-browse" type="button" class="secondary-button">Browse…</button></div></label><label>Allowed client IP<input id="tftp-client" placeholder="e.g. 192.0.2.10" autocomplete="off"></label><div class="form-grid"><label>Listen address<input id="tftp-bind" value="127.0.0.1" autocomplete="off"></label><label>UDP port<input id="tftp-port" type="number" min="1" max="65535" value="6969"></label></div><label class="option-check"><input id="tftp-write" type="checkbox">Allow uploads of new files</label><p class="field-note">The default port 6969 works without elevated privileges. Network equipment commonly expects port 69; use the appropriate host permissions and interface for that device.</p><p id="tftp-state" role="status">Stopped</p><pre id="tftp-transfers" class="script-output" tabindex="0"></pre><div id="tftp-error" class="form-error" hidden></div></div><footer class="modal-footer"><button id="tftp-stop" class="secondary-button" disabled>Stop server</button><button id="tftp-start" class="primary-button">Start server</button></footer></dialog>`;
  document.body.append(wrapper.firstElementChild);
  let rootToken = null, server = { running: false }, busy = false;
  const transfers = new Map();
  function render() {
    for (const id of ['tftp-browse', 'tftp-client', 'tftp-bind', 'tftp-port', 'tftp-write']) $(id).disabled = busy || server.running;
    $('tftp-start').disabled = busy || server.running;
    $('tftp-stop').disabled = busy || !server.running;
    $('tftp-state').textContent = server.running ? `Running on ${server.bindAddress}:${server.port} · ${server.activeTransfers || 0} active · ${server.completedTransfers || 0} completed` : server.lastError ? `Stopped: ${server.lastError}` : 'Stopped';
    $('tftp-transfers').textContent = [...transfers.values()].map(item => `${item.direction === 'read' ? 'Send' : 'Receive'} ${item.filename} · ${item.bytes} bytes · ${item.state}${item.message ? ` · ${item.message}` : ''}`).join('\n');
  }
  function error(value) { $('tftp-error').textContent = value.message || String(value); $('tftp-error').hidden = false; }
  function install() {
    $('tftp-browse').addEventListener('click', async () => {
      try { const chosen = await api.chooseTftpRoot(); if (chosen) { rootToken = chosen.token; $('tftp-root').value = chosen.root; } }
      catch (value) { error(value); }
    });
    $('tftp-start').addEventListener('click', async () => {
      if (!rootToken) { error('Choose the shared folder first.'); return; }
      busy = true; $('tftp-error').hidden = true; render();
      try { server = await api.tftpStart({ rootToken, clientAddress: $('tftp-client').value.trim(), bindAddress: $('tftp-bind').value.trim(), port: Number($('tftp-port').value), allowWrite: $('tftp-write').checked }); }
      catch (value) { error(value); }
      finally { busy = false; render(); }
    });
    $('tftp-stop').addEventListener('click', async () => {
      busy = true; render();
      try { server = await api.tftpStop(); }
      catch (value) { error(value); }
      finally { busy = false; render(); }
    });
    if (api?.onTftpStatus) api.onTftpStatus(value => { server = value; render(); });
    if (api?.onTftpTransfer) api.onTftpTransfer(value => { transfers.set(value.id, value); if (transfers.size > 100) transfers.delete(transfers.keys().next().value); render(); });
  }
  async function perform(action) {
    if (action !== 'tftp-server') return false;
    $('tftp-error').hidden = true;
    if (typeof api.tftpStatus === 'function') server = await api.tftpStatus();
    render(); if (!$('tftp-dialog').open) $('tftp-dialog').showModal(); return true;
  }
  return { install, perform };
}
