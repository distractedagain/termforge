const $ = id => document.getElementById(id);
const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const methods = [['publickey', 'Public key', 'Identity file or SSH agent'], ['keyboard-interactive', 'Keyboard interactive', 'Server prompts and multi-factor authentication'], ['password', 'Password', 'Saved credential or a private prompt']];
export function createAuthOrder(container, prefix) {
  let order = methods.map(([id]) => id); let enabled = new Set(order);
  const render = () => {
    container.replaceChildren();
    order.forEach((id, index) => {
      const [, title, description] = methods.find(entry => entry[0] === id);
      const row = node('div', 'auth-method'); row.dataset.method = id;
      const label = node('label', 'option-check'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = enabled.has(id); checkbox.id = `${prefix}-${id}`; checkbox.addEventListener('change', () => { if (checkbox.checked) enabled.add(id); else enabled.delete(id); });
      const words = node('span'); words.append(node('strong', '', title), node('small', '', description)); label.append(checkbox, words); row.append(label);
      for (const [offset, symbol, direction] of [[-1, '↑', 'earlier'], [1, '↓', 'later']]) {
        const button = node('button', 'icon-button', symbol); button.type = 'button'; button.disabled = index + offset < 0 || index + offset >= order.length; button.setAttribute('aria-label', `Try ${title.toLowerCase()} ${direction}`);
        button.addEventListener('click', () => { [order[index], order[index + offset]] = [order[index + offset], order[index]]; render(); container.querySelector(`[data-method="${id}"] button:not(:disabled)`)?.focus(); }); row.append(button);
      }
      container.append(row);
    });
  };
  return { set(value = methods.map(([id]) => id)) { enabled = new Set(value); order = [...value.filter(id => methods.some(entry => entry[0] === id)), ...methods.map(([id]) => id).filter(id => !value.includes(id))]; render(); }, get: () => order.filter(id => enabled.has(id)) };
}

export function createSecureConnections({ api, toast, confirmAction }) {
  let credentials = []; let editing = ''; let saving = false; let pendingAuth = []; let activeAuth = null;
  const selections = new Set();
  const show = id => { if (!$(id).open) $(id).showModal(); };
  const error = (id, exception) => { $(id).textContent = exception?.message || String(exception); $(id).hidden = false; };
  function populate(select, desired = select.value) {
    const empty = node('option', '', 'Choose a saved credential'); empty.value = '';
    select.replaceChildren(empty, ...credentials.map(entry => { const option = node('option', '', entry.name); option.value = entry.id; return option; }));
    if (desired && !credentials.some(entry => entry.id === desired)) { const missing = node('option', '', 'Unavailable credential — choose another'); missing.value = desired; select.append(missing); }
    select.value = desired || '';
  }
  async function refresh() {
    if (api?.credentialList) credentials = await api.credentialList();
    for (const select of selections) populate(select);
    renderCredentials();
    return credentials;
  }
  function resetForm() { editing = ''; $('credential-form').reset(); $('credential-save').textContent = 'Save credential'; $('credential-form-title').textContent = 'New credential'; $('credential-error').hidden = true; }
  function clearSecrets() { $('credential-username').value = ''; $('credential-password').value = ''; }
  function renderCredentials() {
    if (!$('credential-list')) return;
    $('credential-list').replaceChildren();
    for (const credential of credentials) {
      const row = node('div', 'credential-row'); const detail = node('div'); detail.append(node('strong', '', credential.name), node('small', '', 'Username and password encrypted by this computer'));
      const replace = node('button', 'secondary-button', 'Replace'); replace.type = 'button'; replace.setAttribute('aria-label', `Replace ${credential.name}`); replace.addEventListener('click', () => { resetForm(); editing = credential.id; $('credential-name').value = credential.name; $('credential-form-title').textContent = `Replace ${credential.name}`; $('credential-save').textContent = 'Replace credential'; $('credential-username').focus(); });
      const remove = node('button', 'quiet-button', 'Delete'); remove.type = 'button'; remove.setAttribute('aria-label', `Delete ${credential.name}`); remove.addEventListener('click', async () => { if (saving) return; try { await api.credentialDelete(credential.id); if (editing === credential.id) resetForm(); await refresh(); } catch (exception) { error('credential-error', exception); } });
      row.append(detail, replace, remove); $('credential-list').append(row);
    }
    if (!credentials.length) $('credential-list').append(node('p', 'field-note', 'No saved credentials yet. Add a named credential below.'));
  }
  async function openCredentials() {
    resetForm(); show('credential-dialog'); $('credential-status').textContent = 'Checking protected storage…'; $('credential-save').disabled = true;
    try { const status = await api.credentialStatus(); $('credential-status').textContent = status.message || (status.available ? `Protected storage is ready (${status.backend}).` : 'Protected storage is unavailable. Credentials cannot be saved.'); $('credential-status').dataset.available = String(Boolean(status.available)); $('credential-save').disabled = !status.available; await refresh(); }
    catch (exception) { error('credential-error', exception); }
  }
  async function openHosts() {
    show('ssh-hosts-dialog'); $('ssh-hosts-list').replaceChildren(node('p', 'field-note', 'Loading trusted hosts…'));
    try {
      const hosts = await api.sshHosts(); $('ssh-hosts-list').replaceChildren();
      for (const host of hosts) {
        const row = node('div', 'credential-row'); const details = node('div'); details.append(node('strong', '', `${host.host}:${host.port}`), node('small', '', host.algorithm), node('code', '', host.fingerprint));
        const forget = node('button', 'quiet-button', 'Forget'); forget.type = 'button'; forget.setAttribute('aria-label', `Forget ${host.host}:${host.port}`); forget.addEventListener('click', async () => { try { await api.sshForgetHost({host: host.host, port: host.port}); await openHosts(); } catch (exception) { toast(exception.message, true); } }); row.append(details, forget); $('ssh-hosts-list').append(row);
      }
      if (!hosts.length) $('ssh-hosts-list').append(node('p', 'field-note', 'No managed SSH hosts trusted yet. New fingerprints require your approval when connecting.'));
    } catch (exception) { $('ssh-hosts-list').replaceChildren(node('p', 'form-error', exception.message)); }
  }
  function nextAuth() {
    if (activeAuth || !pendingAuth.length) return;
    activeAuth = pendingAuth.shift();
    const transportLabel = activeAuth.protocol === 'ftp' ? 'FTP (unencrypted)' : ['ftps','ftps-implicit'].includes(activeAuth.protocol) ? 'FTPS' : 'SSH';
    $('auth-title').textContent = activeAuth.kind === 'username' ? `${transportLabel} username` : ['passphrase','key-passphrase'].includes(activeAuth.kind) ? 'Unlock private key' : `${transportLabel} authentication`;
    $('auth-target').textContent = `${activeAuth.username ? `${activeAuth.username}@` : ''}${activeAuth.host}:${activeAuth.port}`;
    $('auth-instructions').textContent = activeAuth.instructions || 'Respond to this server’s authentication request.';
    $('auth-fields').replaceChildren();
    (activeAuth.prompts || []).forEach((prompt, index) => {
      const label = node('label', '', prompt.prompt || 'Response'); const input = node('input'); input.type = prompt.echo ? 'text' : 'password'; input.id = `auth-response-${index}`; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 4096; input.dataset.secret = 'true'; label.append(input); $('auth-fields').append(label);
    });
    show('ssh-auth-dialog'); $('auth-fields').querySelector('input')?.focus();
  }
  async function respondAuth(cancelled) {
    if (!activeAuth) return;
    const current = activeAuth; activeAuth = null;
    const answers = cancelled ? null : [...$('auth-fields').querySelectorAll('input')].map(input => input.value);
    for (const input of $('auth-fields').querySelectorAll('input')) input.value = '';
    $('auth-fields').replaceChildren(); $('ssh-auth-dialog').close();
    try { await api.authRespond({id:current.id, answers}); } catch (exception) { toast(exception.message, true); }
    finally { answers?.fill(''); nextAuth(); }
  }
  function install() {
    const wrapper = node('div');
    wrapper.innerHTML = `<dialog id="credential-dialog" class="modal secure-modal"><header class="modal-header"><div><span class="secure-eyebrow">PRIVATE TO THIS COMPUTER</span><h2>Saved credentials</h2></div><button type="button" class="icon-button" data-secure-close="credential-dialog" aria-label="Close saved credentials">×</button></header><div class="modal-body"><p id="credential-status" class="secure-notice" role="status"></p><div id="credential-list" class="credential-list"></div><form id="credential-form" autocomplete="off"><h3 id="credential-form-title">New credential</h3><label>Name<input id="credential-name" maxlength="120" required placeholder="Production admin"></label><div class="form-grid"><label>Username<input id="credential-username" required maxlength="128" autocomplete="off" data-secret="true"></label><label>Password<input id="credential-password" type="password" required maxlength="4096" autocomplete="new-password" data-secret="true"></label></div><p class="field-note">Only the name appears in your session list. Replacing a credential requires a new username and password. Secrets are excluded from session exports. Saved passwords are used only by Password authentication; keyboard-interactive responses always require a fresh prompt.</p><div id="credential-error" class="form-error" role="alert" hidden></div><div class="secure-form-actions"><button type="button" id="credential-reset" class="quiet-button">Clear form</button><button id="credential-save" type="submit" class="primary-button">Save credential</button></div></form></div><footer class="modal-footer"><button type="button" class="secondary-button" data-secure-close="credential-dialog">Done</button></footer></dialog>
    <dialog id="ssh-hosts-dialog" class="modal secure-modal"><header class="modal-header"><div><span class="secure-eyebrow">MANAGED SSH</span><h2>Trusted hosts</h2></div><button type="button" class="icon-button" data-secure-close="ssh-hosts-dialog" aria-label="Close trusted hosts">×</button></header><div class="modal-body"><p class="field-note">Fingerprints identify servers. Verify a new fingerprint through a trusted source before accepting it. System OpenSSH maintains its own known_hosts file.</p><div id="ssh-hosts-list" class="credential-list"></div></div><footer class="modal-footer"><button type="button" class="secondary-button" data-secure-close="ssh-hosts-dialog">Done</button></footer></dialog>
    <dialog id="ssh-auth-dialog" class="modal secure-modal"><form id="ssh-auth-form" autocomplete="off"><header class="modal-header"><div><span class="secure-eyebrow">PRIVATE AUTHENTICATION</span><h2 id="auth-title">SSH authentication</h2></div></header><div class="modal-body"><strong id="auth-target"></strong><p id="auth-instructions" class="field-note"></p><div id="auth-fields"></div><p class="field-note">Responses go directly to authentication and are cleared from this form. They are not terminal commands or AI context.</p></div><footer class="modal-footer"><button type="button" id="auth-cancel" class="quiet-button">Cancel connection</button><button type="submit" class="primary-button">Continue</button></footer></form></dialog>`;
    document.body.append(wrapper);
    for (const button of wrapper.querySelectorAll('[data-secure-close]')) button.addEventListener('click', () => $(button.dataset.secureClose).close());
    $('credential-dialog').addEventListener('close', clearSecrets); $('credential-dialog').addEventListener('cancel', clearSecrets);
    $('credential-reset').addEventListener('click', resetForm);
    $('credential-form').addEventListener('submit', async event => {
      event.preventDefault(); if (saving) return; saving = true; $('credential-save').disabled = true; $('credential-error').hidden = true;
      const input = { ...(editing ? { id:editing } : {}), name:$('credential-name').value.trim(), username:$('credential-username').value, password:$('credential-password').value };
      clearSecrets();
      try { await api.credentialSave(input); resetForm(); await refresh(); toast('Credential saved using protected storage.'); }
      catch (exception) { error('credential-error', exception); }
      finally { input.username = ''; input.password = ''; saving = false; $('credential-save').disabled = $('credential-status').dataset.available !== 'true'; }
    });
    $('ssh-auth-form').addEventListener('submit', event => { event.preventDefault(); respondAuth(false); }); $('auth-cancel').addEventListener('click', () => respondAuth(true));
    $('ssh-auth-dialog').addEventListener('cancel', event => { event.preventDefault(); respondAuth(true); });
    api?.onAuthPromptClosed?.(({id}) => {
      pendingAuth = pendingAuth.filter(prompt => prompt.id !== id);
      if (activeAuth?.id !== id) return;
      activeAuth = null; for (const input of $('auth-fields').querySelectorAll('input')) input.value = '';
      $('auth-fields').replaceChildren(); $('ssh-auth-dialog').close(); nextAuth();
    });
    api?.onAuthPrompt?.(prompt => { if (!prompt || typeof prompt.id !== 'string' || !Array.isArray(prompt.prompts)) return; pendingAuth.push(prompt); nextAuth(); });
  }
  return { install, refresh, openCredentials, openHosts, register(select, selected = '') { selections.add(select); populate(select, selected); refresh().catch(() => {}); }, select(select, selected = '') { populate(select, selected); refresh().catch(() => {}); }, async perform(action) { if (action === 'credentials') { await openCredentials(); return true; } if (action === 'ssh-hosts') { await openHosts(); return true; } return false; } };
}
