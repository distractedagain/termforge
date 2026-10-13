import './key-tools.css';

const element = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
export function initKeyTools({ api, toast = () => {} }) {
  let mode = 'create-public-key', busy = false;
  const dialog = element('dialog', 'modal key-tools-modal'); dialog.id = 'key-tools-dialog'; dialog.setAttribute('aria-labelledby', 'key-tools-title');
  const form = element('form');
  const header = element('header', 'modal-header'); const title = element('h2'); title.id = 'key-tools-title';
  const close = element('button', 'icon-button', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close SSH key tools');
  header.append(title, close);
  const body = element('div', 'modal-body');
  const note = element('p', 'field-note');
  const generatedFields = element('div', 'key-tools-fields');
  const typeLabel = element('label', '', 'Key type'); const type = element('select'); type.id = 'key-tools-type';
  for (const [value, label] of [['ed25519', 'Ed25519'], ['rsa', 'RSA · 3072 bits']]) { const option = element('option', '', label); option.value = value; type.append(option); }
  typeLabel.append(type);
  const commentLabel = element('label', '', 'Comment (optional)'); const comment = element('input'); comment.id = 'key-tools-comment'; comment.maxLength = 240; comment.autocomplete = 'off'; comment.placeholder = 'A name to recognize this key'; commentLabel.append(comment);
  generatedFields.append(typeLabel, commentLabel);
  function secretField(id, text) { const label = element('label', '', text); const input = element('input'); input.type = 'password'; input.id = id; input.autocomplete = 'off'; input.maxLength = 1000; input.spellcheck = false; label.append(input); return { label, input }; }
  const old = secretField('key-tools-old-passphrase', 'Current passphrase (leave empty for an unencrypted source)');
  const pass = secretField('key-tools-passphrase', 'New passphrase');
  const confirm = secretField('key-tools-confirm-passphrase', 'Confirm new passphrase');
  const choice = element('label', 'option-check'); const unencrypted = element('input'); unencrypted.type = 'checkbox'; unencrypted.id = 'key-tools-unencrypted'; choice.append(unencrypted, element('span', '', 'Save without a passphrase (unencrypted private key)'));
  const privacy = element('p', 'field-note', 'Choose a new private-key filename in the next step. A matching .pub file is saved beside it. Existing files are never overwritten. Passphrases are used for this operation and are not saved in TermForge.');
  const result = element('pre', 'key-tools-result'); result.id = 'key-tools-result'; result.hidden = true; result.setAttribute('role', 'status'); result.tabIndex = 0;
  const error = element('p', 'form-error'); error.id = 'key-tools-error'; error.hidden = true; error.setAttribute('role', 'alert');
  const controls = element('div', 'key-tools-fields'); controls.append(generatedFields, old.label, pass.label, confirm.label, choice, privacy);
  body.append(note, controls, result, error);
  const footer = element('footer', 'modal-footer'); const cancel = element('button', 'quiet-button', 'Close'); cancel.type = 'button';
  const submit = element('button', 'primary-button', 'Choose destination…'); submit.type = 'submit'; submit.id = 'key-tools-submit'; footer.append(cancel, submit);
  form.append(header, body, footer); dialog.append(form); document.body.append(dialog);
  function clearSecrets() { old.input.value = ''; pass.input.value = ''; confirm.input.value = ''; }
  function dismiss() { if (busy) return; clearSecrets(); dialog.close(); }
  close.addEventListener('click', dismiss); cancel.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else clearSecrets(); });
  dialog.addEventListener('close', clearSecrets);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
  });
  function syncPassphrase() { pass.input.disabled = confirm.input.disabled = unencrypted.checked; pass.input.required = confirm.input.required = !unencrypted.checked; pass.input.minLength = unencrypted.checked ? 0 : 8; if (unencrypted.checked) { pass.input.value = ''; confirm.input.value = ''; } }
  unencrypted.addEventListener('change', syncPassphrase);
  function setBusy(value) { busy = value; submit.disabled = value; close.disabled = value; cancel.disabled = value; controls.inert = value; dialog.setAttribute('aria-busy', String(value)); }
  function showError(exception) { error.textContent = exception?.message || String(exception); error.hidden = false; }
  async function listAgent() {
    setBusy(true); error.hidden = true;
    try {
      const state = await api.keyToolsAgentList();
      result.textContent = [state.message, ...state.keys.map(key => `${key.type} · ${key.bits} bits\n${key.fingerprint}\n${key.comment}`)].join('\n\n'); result.hidden = false;
    } catch (exception) { showError(exception); }
    finally { setBusy(false); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    if (mode === 'agent-keys') { await listAgent(); return; }
    error.hidden = true; result.hidden = true;
    if (!unencrypted.checked && pass.input.value !== confirm.input.value) { showError(new Error('The new passphrases do not match.')); confirm.input.focus(); return; }
    setBusy(true);
    const passphrase = unencrypted.checked ? '' : pass.input.value;
    const request = mode === 'create-public-key' ? { type: type.value, comment: comment.value, passphrase, allowUnencrypted: unencrypted.checked } : { oldPassphrase: old.input.value, newPassphrase: passphrase, allowUnencrypted: unencrypted.checked };
    // Clear DOM secrets before awaiting native pickers and the subprocess.
    clearSecrets();
    try {
      const saved = await (mode === 'create-public-key' ? api.keyToolsGenerate(request) : api.keyToolsConvert(request));
      if (!saved.canceled) {
        result.textContent = `${saved.encrypted ? 'Encrypted' : 'Unencrypted'} OpenSSH private key saved\n${saved.privatePath}\n\nPublic key\n${saved.publicPath}\n\nFingerprint\n${saved.fingerprint}`;
        result.hidden = false; toast(mode === 'create-public-key' ? 'SSH key pair created' : 'OpenSSH key copy saved');
      }
    } catch (exception) { showError(exception); }
    finally { request.passphrase = ''; request.newPassphrase = ''; request.oldPassphrase = ''; setBusy(false); }
  });
  async function run(action) {
    if (!['create-public-key', 'convert-private-key', 'agent-keys'].includes(action)) return false;
    if (busy) { if (!dialog.open) dialog.showModal(); return true; }
    mode = action; form.reset(); clearSecrets(); error.hidden = true; result.hidden = true;
    const agent = action === 'agent-keys', converting = action === 'convert-private-key';
    controls.hidden = agent; generatedFields.hidden = converting; old.label.hidden = !converting;
    title.textContent = agent ? 'Manage Agent Keys' : converting ? 'Convert Private Key to OpenSSH' : 'Create Public Key';
    note.textContent = agent ? 'View the identities available through your system OpenSSH agent. This view does not add, remove, or unlock keys.' : converting ? 'Create an OpenSSH copy of an existing OpenSSH or PEM private key. Choose the source and a new destination in the next step. The source is unchanged. PuTTY and proprietary SecureCRT key formats are not supported.' : 'Create a private/public SSH key pair using the OpenSSH tools installed on this computer. Only share the .pub file with servers.';
    submit.textContent = agent ? 'Refresh' : converting ? 'Choose source and destination…' : 'Choose destination…';
    // Hidden key inputs must not prevent the agent's Refresh submission.
    for (const input of [old.input, pass.input, confirm.input]) input.required = false;
    if (!agent) syncPassphrase();
    if (!dialog.open) dialog.showModal();
    if (agent) await listAgent(); else (converting ? old.input : type).focus();
    return true;
  }
  return { run };
}
