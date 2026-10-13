import './quick-connect.css';

const api = window.termforgeQuickConnect;
const $ = id => document.getElementById(id);
const methods = [
  ['publickey', 'Public key'],
  ['keyboard-interactive', 'Keyboard interactive'],
  ['password', 'Password']
];
let order = methods.map(([id]) => id);
const enabled = new Set(order);
let selectedMethod = order[0];
let ready = false;
let busy = false;

function showError(error) {
  $('quick-error').textContent = error?.message || String(error);
  $('quick-error').hidden = false;
}

function updateArrows() {
  const index = order.indexOf(selectedMethod);
  $('quick-auth-up').disabled = index <= 0;
  $('quick-auth-down').disabled = index < 0 || index === order.length - 1;
}

function selectMethod(id) {
  selectedMethod = id;
  for (const row of $('quick-auth-order').children) {
    row.classList.toggle('selected', row.dataset.method === id);
    row.tabIndex = row.dataset.method === id ? 0 : -1;
  }
  updateArrows();
}

function moveMethod(offset, focus = false) {
  const index = order.indexOf(selectedMethod);
  if (index + offset < 0 || index + offset >= order.length) return;
  [order[index], order[index + offset]] = [order[index + offset], order[index]];
  renderMethods();
  if (focus) $('quick-auth-order').querySelector(`[data-method="${selectedMethod}"]`).focus();
}

function renderMethods() {
  const rows = order.map(id => {
    const row = document.createElement('div');
    row.className = 'auth-method'; row.dataset.method = id;
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.id = `quick-auth-${id}`; checkbox.checked = enabled.has(id);
    checkbox.addEventListener('change', () => { if (checkbox.checked) enabled.add(id); else enabled.delete(id); });
    label.append(checkbox, methods.find(entry => entry[0] === id)[1]); row.append(label);
    row.addEventListener('click', () => selectMethod(id));
    row.addEventListener('focusin', () => selectMethod(id));
    row.addEventListener('keydown', event => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); const offset = event.key === 'ArrowUp' ? -1 : 1;
        if (event.altKey) moveMethod(offset, true);
        else { const next = order[Math.max(0, Math.min(order.length - 1, order.indexOf(id) + offset))]; selectMethod(next); $('quick-auth-order').querySelector(`[data-method="${next}"]`).focus(); }
      } else if (event.key === ' ' && event.target === row) {
        event.preventDefault(); checkbox.click();
      }
    });
    return row;
  });
  $('quick-auth-order').replaceChildren(...rows); selectMethod(selectedMethod);
}

function updateFields() {
  const protocol = $('quick-protocol').value;
  const remote = ['ssh', 'sftp', 'telnet', 'raw'].includes(protocol);
  const ssh = ['ssh', 'sftp'].includes(protocol);
  const fileSession = protocol === 'sftp' || protocol === 'ssh' && $('quick-sftp').checked;
  for (const key of ['host', 'port']) { $(`quick-${key}-label`).hidden = !remote; $(`quick-${key}`).disabled = !remote; $(`quick-${key}`).required = remote; }
  $('quick-sftp-label').hidden = protocol !== 'ssh'; $('quick-sftp').disabled = protocol !== 'ssh';
  $('quick-backend-label').hidden = !ssh;
  if (fileSession) $('quick-backend').value = 'managed';
  $('quick-backend').disabled = !ssh || fileSession;
  const managed = ssh && $('quick-backend').value === 'managed';
  if (!managed) $('quick-use-username').checked = true;
  const credential = managed && $('quick-use-credential').checked;
  $('quick-auth-fields').hidden = !ssh;
  $('quick-user').disabled = !ssh || credential;
  $('quick-credentials-label').hidden = !managed;
  $('quick-credential').disabled = !credential;
  $('quick-credential').required = credential;
  $('quick-managed-auth').hidden = !managed;
  $('quick-managed-auth').disabled = !managed;
  $('quick-identity').disabled = !ssh;
  $('quick-choose-identity').disabled = !ssh;
  $('quick-auth-note').textContent = managed
    ? 'Jump hosts, forwarding, certificates and GSSAPI are available with System OpenSSH in Session Options.'
    : 'System OpenSSH prompts in the terminal. Configure advanced authentication and forwarding in Session Options.';
  $('quick-serial-label').hidden = protocol !== 'serial'; $('quick-serial').disabled = protocol !== 'serial'; $('quick-serial').required = protocol === 'serial';
  $('quick-cwd-label').hidden = protocol !== 'local'; $('quick-cwd').disabled = protocol !== 'local';
  $('quick-name-label').hidden = !$('quick-save').checked; $('quick-name').disabled = !$('quick-save').checked; $('quick-name').required = $('quick-save').checked;
  $('quick-destination-note').textContent = fileSession ? 'Opens in the SFTP / SCP file workspace.' : protocol === 'serial' ? 'Opens in a terminal tab at 9600 baud.' : 'Opens in a terminal tab.';
}

function setCredentials(entries = []) {
  const desired = $('quick-credential').value;
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Choose a saved credential';
  const options = entries.filter(entry => typeof entry?.id === 'string' && typeof entry.name === 'string').map(entry => { const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name; return option; });
  $('quick-credential').replaceChildren(empty, ...options);
  $('quick-credential').value = options.some(option => option.value === desired) ? desired : '';
}

function makeProfile() {
  const protocol = $('quick-protocol').value;
  const ssh = ['ssh', 'sftp'].includes(protocol);
  const fileSession = protocol === 'sftp' || protocol === 'ssh' && $('quick-sftp').checked;
  const profile = {
    name: $('quick-name').value.trim() || $('quick-host').value.trim() || (protocol === 'local' ? 'Local shell' : 'Serial'),
    protocol: fileSession ? 'sftp' : protocol,
    host: $('quick-host').disabled ? '' : $('quick-host').value.trim(),
    port: Number($('quick-port').value),
    username: ssh ? $('quick-user').value.trim() : '',
    cwd: protocol === 'local' ? $('quick-cwd').value.trim() : '',
    serial: { path: protocol === 'serial' ? $('quick-serial').value.trim() : '', baudRate: 9600 },
    forwardings: []
  };
  if (ssh) {
    const managed = $('quick-backend').value === 'managed';
    profile.ssh = { backend: $('quick-backend').value, authOrder: managed ? order.filter(id => enabled.has(id)) : methods.map(([id]) => id) };
    if (managed && !profile.ssh.authOrder.length) throw new Error('Enable at least one authentication method.');
    profile.identityFile = $('quick-identity').value.trim();
    if (managed && $('quick-use-credential').checked) { profile.credentialId = $('quick-credential').value; profile.username = ''; }
  }
  return profile;
}

async function close() {
  if (busy) return;
  try { await api.close(); } catch (error) { showError(error); }
}

async function submit(event) {
  event.preventDefault();
  if (!ready || busy) return;
  $('quick-error').hidden = true;
  try {
    const payload = { profile: makeProfile(), saveSession: $('quick-save').checked, showOnStartup: $('quick-startup').checked };
    busy = true; $('quick-fields').disabled = true; $('quick-submit').disabled = true; $('quick-cancel').disabled = true;
    $('quick-submit').textContent = 'Connecting…';
    const result = await api.submit(payload);
    if (!result?.accepted) throw new Error('The connection was not accepted. Please try again.');
    // Main closes this window after acknowledging the connection request.
  } catch (error) {
    busy = false; $('quick-fields').disabled = false; $('quick-submit').disabled = false; $('quick-cancel').disabled = false;
    $('quick-submit').textContent = 'Connect'; showError(error);
  }
}

async function initialize() {
  renderMethods(); updateFields();
  $('quick-connect-form').addEventListener('submit', submit);
  $('quick-cancel').addEventListener('click', close);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  $('quick-protocol').addEventListener('change', () => { $('quick-port').value = ['telnet', 'raw'].includes($('quick-protocol').value) ? '23' : '22'; updateFields(); });
  for (const id of ['quick-backend', 'quick-use-username', 'quick-use-credential', 'quick-sftp', 'quick-save']) $(id).addEventListener('change', updateFields);
  $('quick-auth-up').addEventListener('click', () => moveMethod(-1));
  $('quick-auth-down').addEventListener('click', () => moveMethod(1));
  $('quick-choose-identity').addEventListener('click', async () => {
    $('quick-choose-identity').disabled = true;
    try { const file = await api.chooseIdentityFile(); if (file) $('quick-identity').value = file; }
    catch (error) { showError(error); }
    finally { updateFields(); }
  });
  $('quick-manage-credentials').addEventListener('click', async () => {
    $('quick-manage-credentials').disabled = true;
    try { await api.manageCredentials(); }
    catch (error) { showError(error); }
    finally { $('quick-manage-credentials').disabled = false; }
  });
  try {
    if (!api) throw new Error('Quick Connect is available from the TermForge desktop app.');
    api.onCredentialsChanged?.(setCredentials);
    api.onFileSession?.(() => { if (!busy) { if (!['ssh','sftp'].includes($('quick-protocol').value)) $('quick-port').value = '22'; $('quick-protocol').value = 'ssh'; $('quick-sftp').checked = true; updateFields(); $('quick-host').focus(); } });
    const state = await api.getState();
    if (state.fileSession) $('quick-sftp').checked = true;
    document.documentElement.dataset.platform = state.platform || '';
    $('quick-startup').checked = Boolean(state.settings?.showQuickConnectOnStartup);
    setCredentials(state.credentials);
    if (state.credentialError) showError(state.credentialError);
    $('serial-port-options').replaceChildren(...(state.serialPorts || []).map(port => { const option = document.createElement('option'); option.value = port.path; option.label = port.friendlyName || port.manufacturer || port.path; return option; }));
    ready = true; $('quick-fields').disabled = false; $('quick-submit').disabled = false; $('quick-status').hidden = true;
    updateFields(); $('quick-host').focus();
  } catch (error) { $('quick-status').hidden = true; showError(error); }
}

initialize();
