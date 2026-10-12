// Original category dialogs, with only controls that TermForge can apply.
import { installKeymapEditor, loadMappings, readMappings } from './keymap.js';
const $ = (id) => document.getElementById(id);
const node = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};

export function field(id, labelText, type = 'text', options = {}) {
  const label = node('label', type === 'checkbox' ? 'option-check' : '', labelText);
  const control = node(type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  control.id = id;
  if (!['select', 'textarea'].includes(type)) control.type = type;
  if (type === 'select') for (const entry of options.values || []) {
    const [value, text] = Array.isArray(entry) ? entry : [entry, entry];
    const option = node('option', '', text); option.value = value; control.append(option);
  }
  for (const key of ['min', 'max', 'step', 'placeholder', 'maxLength']) if (options[key] !== undefined) control[key] = options[key];
  if (type === 'textarea') { control.rows = options.rows || 3; control.spellcheck = false; }
  if (type === 'checkbox') label.prepend(control); else label.append(control);
  return label;
}

function categoryDialog(id, pages) {
  const dialog = $(id);
  const body = dialog.querySelector('.modal-body');
  const original = [...body.childNodes];
  body.replaceChildren(); body.classList.add('category-layout');
  const tree = node('nav', 'category-tree'); tree.setAttribute('aria-label', 'Option categories');
  const content = node('div', 'category-content');
  pages[0].elements = original;
  for (const page of pages) {
    const button = node('button', `category-item${page.child ? ' category-child' : ''}`, page.label);
    button.type = 'button'; button.dataset.category = page.id;
    const section = node('section', 'category-page'); section.id = `${id}-${page.id}`; section.dataset.category = page.id;
    section.append(node('h3', 'category-title', page.title || page.label), ...page.elements);
    const show = () => {
      for (const other of content.children) other.hidden = other !== section;
      for (const other of tree.children) { other.classList.toggle('selected', other === button); other.setAttribute('aria-current', String(other === button)); }
    };
    button.addEventListener('click', show); tree.append(button); content.append(section);
    section.hidden = page !== pages[0]; button.setAttribute('aria-current', String(page === pages[0]));
    if (page === pages[0]) button.classList.add('selected');
  }
  body.append(tree, content);
  dialog.classList.add('category-modal');
}

export function selectCategory(dialogId, category = 'connection') {
  $(`${dialogId}`).querySelector(`.category-item[data-category="${category}"]`)?.click();
}

const schemes = [['', 'Use Global Options'], ['traditional', 'Traditional (black)'], ['monochrome', 'Monochrome'], ['solarized-dark', 'Solarized dark'], ['solarized-light', 'Solarized light']];

export function installOptionDialogs() {
  const protocolSelect = field('profile-protocol-select', 'Protocol', 'select', { values: [['ssh', 'SSH2'], ['sftp', 'SFTP'], ['telnet', 'Telnet'], ['raw', 'Raw TCP'], ['serial', 'Serial'], ['local', 'Local shell']] });
  $('profile-dialog').querySelector('.protocol-picker').hidden = true;
  $('profile-dialog').querySelector('.protocol-picker').after(protocolSelect);
  const serial = node('div', 'serial-options');
  serial.append(field('profile-serial-path', 'Serial port', 'text', { placeholder: '/dev/cu.usbserial… or COM3' }));
  serial.querySelector('#profile-serial-path').setAttribute('list', 'serial-port-options');
  const choices = node('datalist'); choices.id = 'serial-port-options'; serial.append(choices);
  const refresh = node('button', 'secondary-button', 'Refresh serial ports'); refresh.id = 'refresh-serial-ports'; refresh.type = 'button'; serial.append(refresh);
  serial.append(field('profile-serial-baud', 'Baud rate', 'select', { values: ['300', '1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'] }), field('profile-serial-bits', 'Data bits', 'select', { values: ['5', '6', '7', '8'] }), field('profile-serial-stop', 'Stop bits', 'select', { values: ['1', '1.5', '2'] }), field('profile-serial-parity', 'Parity', 'select', { values: ['none', 'even', 'odd', 'mark', 'space'] }), field('profile-serial-flow', 'Flow control', 'select', { values: [['none', 'None'], ['rtscts', 'RTS/CTS'], ['xonxoff', 'XON/XOFF']] }));
  const ssh = [
    field('profile-auth', 'Authentication', 'select', { values: [['auto', 'Automatic (OpenSSH)'], ['publickey', 'Public key'], ['password', 'Password'], ['keyboard-interactive', 'Keyboard interactive'], ['gssapi', 'GSSAPI']] }),
    field('profile-certificate', 'OpenSSH certificate file', 'text', { placeholder: 'Optional signed public-key certificate' }),
    field('profile-compression', 'Enable compression', 'checkbox'), field('profile-agent-forwarding', 'Forward SSH agent', 'checkbox'), field('profile-x11-forwarding', 'Forward X11 display', 'checkbox'),
    field('profile-keepalive', 'Keep-alive interval (seconds; 0 disables)', 'number', { min: 0, max: 3600 }), field('profile-keepalive-count', 'Keep-alive unanswered count', 'number', { min: 1, max: 100 }), field('profile-connect-timeout', 'Connect timeout (seconds)', 'number', { min: 1, max: 600 }),
    field('profile-remote-command', 'Remote command (optional)', 'textarea', { maxLength: 4096, rows: 2 }),
    field('profile-ciphers', 'Ciphers (comma-separated OpenSSH names)', 'text', { placeholder: 'Leave empty for OpenSSH defaults' }), field('profile-kex', 'Key exchange algorithms', 'text', { placeholder: 'Leave empty for OpenSSH defaults' }), field('profile-macs', 'MAC algorithms', 'text', { placeholder: 'Leave empty for OpenSSH defaults' }),
    node('p', 'field-note', 'System OpenSSH verifies host keys and performs authentication. These options apply to the next connection. Agent and X11 forwarding give the remote host access to those services.')
  ];
  categoryDialog('profile-dialog', [
    { id: 'connection', label: 'Connection', elements: [] },
    { id: 'ssh', label: 'SSH2', child: true, title: 'SSH2 — Authentication and advanced', elements: ssh },
    { id: 'serial', label: 'Serial', child: true, elements: [serial] },
    { id: 'emulation', label: 'Terminal', title: 'Terminal — Emulation', elements: [field('profile-terminal-type', 'Terminal type advertised to the server', 'select', { values: ['xterm-256color', 'xterm', 'vt100', 'vt220', 'ansi'] }), node('p', 'field-note', 'TermForge uses the xterm terminal engine. The terminal type controls TERM and protocol negotiation; it does not provide a separate Wyse, TN3270, or VT220 emulator.'), field('profile-scrollback', 'Scrollback lines (0 uses Global Options)', 'number', { min: 0, max: 128000 }), field('profile-local-echo', 'Local echo', 'checkbox')] },
    { id: 'appearance', label: 'Appearance', child: true, elements: [field('profile-font-family', 'Font family (empty uses Global Options)'), field('profile-font-size', 'Font size (0 uses Global Options)', 'number', { min: 0, max: 72 }), field('profile-color-scheme', 'Color scheme', 'select', { values: schemes }), field('profile-cursor', 'Cursor', 'select', { values: [['', 'Use Global Options'], ['block', 'Block'], ['bar', 'Vertical bar'], ['underline', 'Underline']] }), field('profile-cursor-blink', 'Cursor blinking', 'select', { values: [['inherit', 'Use Global Options'], ['true', 'Blink'], ['false', 'Steady']] })] },
    { id: 'keyboard', label: 'Keyboard', child: true, elements: [field('profile-backspace', 'Backspace sends', 'select', { values: [['del', 'DEL (0x7F)'], ['bs', 'BS (0x08)']] }), field('profile-delete', 'Delete sends', 'select', { values: [['escape', 'Escape sequence'], ['del', 'DEL (0x7F)']] }), field('profile-emacs', 'Use Option / Alt as Meta (Emacs mode)', 'checkbox'), (() => { const container = node('div'); container.id = 'profile-mapped-keys'; return container; })()] }
  ]);
  installKeymapEditor($('profile-mapped-keys'));
  categoryDialog('settings-dialog', [
    { id: 'general', label: 'General', elements: [] },
    { id: 'appearance', label: 'Terminal', title: 'Terminal — Appearance', elements: [field('settings-font-family', 'Font family', 'text', { maxLength: 200 }), field('settings-color-scheme', 'Color scheme', 'select', { values: schemes.slice(1) }), field('settings-cursor', 'Cursor', 'select', { values: [['block', 'Block'], ['bar', 'Vertical bar'], ['underline', 'Underline']] }), field('settings-cursor-blink', 'Blink cursor', 'checkbox'), field('settings-bell', 'Bell', 'select', { values: [['none', 'None'], ['visual', 'Visual flash']] }), field('settings-word-delimiters', 'Word selection delimiters', 'text', { maxLength: 120 }), field('settings-close-exit', 'Close session tab when terminal exits', 'checkbox')] },
    { id: 'mouse', label: 'Mouse and paste', child: true, elements: [field('settings-copy-select', 'Copy selected terminal text automatically', 'checkbox'), field('settings-paste-right', 'Paste on right-click', 'checkbox'), field('settings-confirm-paste', 'Review multiline clipboard paste', 'checkbox'), field('settings-history-limit', 'Command history entries (0 disables)', 'number', { min: 0, max: 200 }), node('p', 'field-note', 'Command Window history is saved locally. Passwords entered directly into a terminal are not added to this history.')] },
    { id: 'keywords', label: 'Keyword Highlighting', child: true, elements: [field('settings-keywords-enabled', 'Enable keyword highlighting', 'checkbox'), node('p', 'field-note', 'Each rule matches literal words or substrings. Regular expressions are not yet supported.'), (() => { const editor = node('div'); editor.id = 'keyword-editor'; return editor; })(), (() => { const add = node('button', 'secondary-button', 'Add keyword'); add.type = 'button'; add.id = 'add-keyword'; return add; })()] }
  ]);
}

export const sessionExtraFields = {
  'profile-terminal-type': ['terminal', 'terminalType', 'xterm-256color'], 'profile-scrollback': ['terminal', 'scrollback', 0], 'profile-local-echo': ['terminal', 'localEcho', false], 'profile-font-family': ['terminal', 'fontFamily', ''], 'profile-font-size': ['terminal', 'fontSize', 0], 'profile-color-scheme': ['terminal', 'colorScheme', ''], 'profile-cursor': ['terminal', 'cursorStyle', ''], 'profile-cursor-blink': ['terminal', 'cursorBlink', null], 'profile-backspace': ['terminal', 'backspaceMode', 'del'], 'profile-delete': ['terminal', 'deleteMode', 'escape'], 'profile-emacs': ['terminal', 'emacsMode', false],
  'profile-auth': ['ssh', 'authMethod', 'auto'], 'profile-certificate': ['ssh', 'certificateFile', ''], 'profile-compression': ['ssh', 'compression', false], 'profile-agent-forwarding': ['ssh', 'agentForwarding', false], 'profile-x11-forwarding': ['ssh', 'x11Forwarding', false], 'profile-keepalive': ['ssh', 'keepAliveInterval', 30], 'profile-keepalive-count': ['ssh', 'keepAliveCountMax', 3], 'profile-connect-timeout': ['ssh', 'connectTimeout', 15], 'profile-remote-command': ['ssh', 'remoteCommand', ''], 'profile-ciphers': ['ssh', 'ciphers', []], 'profile-kex': ['ssh', 'keyExchanges', []], 'profile-macs': ['ssh', 'macs', []],
  'profile-serial-path': ['serial', 'path', ''], 'profile-serial-baud': ['serial', 'baudRate', 9600], 'profile-serial-bits': ['serial', 'dataBits', 8], 'profile-serial-stop': ['serial', 'stopBits', 1], 'profile-serial-parity': ['serial', 'parity', 'none'], 'profile-serial-flow': ['serial', 'flowControl', 'none']
};

export function loadExtraProfile(profile = {}) {
  loadMappings(profile.terminal?.mappedKeys || []);
  for (const [id, [section, key, fallback]] of Object.entries(sessionExtraFields)) {
    const control = $(id); const value = profile[section]?.[key] ?? fallback;
    if (control.type === 'checkbox') control.checked = Boolean(value);
    else control.value = Array.isArray(value) ? value.join(', ') : value === null ? 'inherit' : String(value);
  }
}

export function readExtraProfile() {
  const result = { terminal: {}, ssh: {}, serial: {} };
  for (const [id, [section, key, fallback]] of Object.entries(sessionExtraFields)) {
    const control = $(id);
    let value = control.type === 'checkbox' ? control.checked : control.value.trim();
    if (typeof fallback === 'number') value = Number(value);
    if (Array.isArray(fallback)) value = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (fallback === null) value = value === 'inherit' ? null : value === 'true';
    result[section][key] = value;
  }
  result.terminal.mappedKeys = readMappings();
  return result;
}

export const globalExtraFields = {
  'settings-font-family': ['fontFamily', '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace'], 'settings-color-scheme': ['colorScheme', 'traditional'], 'settings-cursor': ['cursorStyle', 'block'], 'settings-cursor-blink': ['cursorBlink', true], 'settings-bell': ['bellStyle', 'none'], 'settings-word-delimiters': ['wordDelimiters', ' ()[]{}\'"'], 'settings-close-exit': ['closeOnExit', false], 'settings-copy-select': ['copyOnSelect', false], 'settings-paste-right': ['pasteOnRightClick', false], 'settings-confirm-paste': ['confirmPaste', true], 'settings-history-limit': ['commandHistoryLimit', 100], 'settings-keywords-enabled': ['keywordHighlightEnabled', true]
};

export function loadExtraSettings(settings) {
  for (const [id, [key, fallback]] of Object.entries(globalExtraFields)) {
    if ($(id).type === 'checkbox') $(id).checked = Boolean(settings[key] ?? fallback); else $(id).value = String(settings[key] ?? fallback);
  }
  $('keyword-editor').replaceChildren(); for (const rule of settings.keywords || []) addKeywordRule(rule);
}

export function addKeywordRule(rule = {}) {
  const row = node('div', 'keyword-edit-row');
  const input = node('input'); input.value = rule.text || ''; input.maxLength = 128; input.placeholder = 'Literal word or phrase'; input.dataset.field = 'text'; input.setAttribute('aria-label', 'Keyword');
  const foreground = node('input'); foreground.type = 'color'; foreground.value = rule.foreground || '#000000'; foreground.dataset.field = 'foreground'; foreground.setAttribute('aria-label', 'Keyword foreground');
  const background = node('input'); background.type = 'color'; background.value = rule.background || '#70e330'; background.dataset.field = 'background'; background.setAttribute('aria-label', 'Keyword background');
  const sensitive = node('input'); sensitive.type = 'checkbox'; sensitive.checked = Boolean(rule.caseSensitive); sensitive.dataset.field = 'caseSensitive'; sensitive.setAttribute('aria-label', 'Keyword match case');
  const check = node('label', 'check-label', 'Match case'); check.prepend(sensitive);
  const remove = node('button', 'icon-button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove keyword'); remove.addEventListener('click', () => row.remove());
  row.append(input, foreground, background, check, remove); $('keyword-editor').append(row); return input;
}

export function readExtraSettings() {
  const result = {};
  for (const [id, [key, fallback]] of Object.entries(globalExtraFields)) result[key] = $(id).type === 'checkbox' ? $(id).checked : typeof fallback === 'number' ? Number($(id).value) : $(id).value.trim();
  result.keywords = [...$('keyword-editor').children].map((row) => ({ text: row.querySelector('[data-field="text"]').value.trim(), foreground: row.querySelector('[data-field="foreground"]').value, background: row.querySelector('[data-field="background"]').value, caseSensitive: row.querySelector('[data-field="caseSensitive"]').checked })).filter((rule) => rule.text);
  return result;
}
