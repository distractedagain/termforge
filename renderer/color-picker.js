import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { COLOR_SCHEMES, ANSI_COLOR_KEYS, resolveColorScheme } from '../app/color-schemes.cjs';
import './color-picker.css';

const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

// These are local ANSI bytes rendered by the same engine as live sessions.
// A preview never opens a connection, shell, or script.
const ANSI_SAMPLE = [
  '\x1b[32mtermforge\x1b[0m@demo:~ $ ./status',
  '\x1b[1mConnection ready\x1b[0m  \x1b[2mSSH2 · UTF-8\x1b[0m',
  '\x1b[33mWarning\x1b[0m: retries 1   \x1b[31mError\x1b[0m: 0',
  '\x1b[34mprojects/\x1b[0m  \x1b[36mconfig.json\x1b[0m  \x1b[35mnotes.md\x1b[0m',
  `Normal ${Array.from({ length: 8 }, (_, index) => `\x1b[${30 + index}m██\x1b[0m`).join(' ')}`,
  `Bright ${Array.from({ length: 8 }, (_, index) => `\x1b[${90 + index}m██\x1b[0m`).join(' ')}`,
  '\x1b[32mtermforge\x1b[0m@demo:~ $ ',
].join('\r\n');

function createAnsiPreview(host, getScheme) {
  let terminal = null;
  let fit = null;
  let frame = 0;
  let destroyed = false;
  host.setAttribute('role', 'img');
  const dispose = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    terminal?.dispose(); terminal = null; fit = null;
    host.replaceChildren();
  };
  const render = () => {
    frame = 0;
    if (destroyed) return;
    const scheme = getScheme();
    host.style.backgroundColor = scheme.theme.background;
    host.style.setProperty('--scheme-preview-background', scheme.theme.background);
    host.dataset.scheme = scheme.id;
    host.setAttribute('aria-label', `${scheme.name} terminal preview with normal and bright ANSI colors, a command prompt, and sample status text.`);
    if (!host.isConnected || !host.getClientRects().length || host.clientWidth < 40 || host.clientHeight < 40) {
      dispose(); return;
    }
    if (!terminal) {
      terminal = new Terminal({
        theme: { ...scheme.theme }, cols: 48, rows: 7, scrollback: 0,
        disableStdin: true, cursorBlink: false, cursorStyle: 'block',
        fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 12, lineHeight: 1.2, allowProposedApi: false,
      });
      fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host);
      terminal.element?.setAttribute('aria-hidden', 'true');
      if (terminal.textarea) { terminal.textarea.tabIndex = -1; terminal.textarea.readOnly = true; }
      fit.fit();
      terminal.write(ANSI_SAMPLE);
    } else {
      terminal.options.theme = { ...scheme.theme };
      fit.fit();
    }
  };
  const refresh = () => {
    if (!destroyed && !frame) frame = requestAnimationFrame(render);
  };
  const observer = new ResizeObserver(refresh);
  observer.observe(host);
  refresh();
  return {
    refresh, dispose,
    destroy() { destroyed = true; observer.disconnect(); dispose(); },
  };
}

/** A local ANSI sample for a global or per-session color-scheme select. */
export function createSchemePreview(select, { getInheritedScheme = () => 'traditional' } = {}) {
  const element = make('figure', 'scheme-inline-preview');
  const caption = make('figcaption', 'scheme-preview-caption');
  const host = make('div', 'scheme-ansi-preview');
  element.append(caption, host);
  const getScheme = () => resolveColorScheme(select.value, getInheritedScheme());
  const preview = createAnsiPreview(host, getScheme);
  const refresh = () => {
    const scheme = getScheme();
    caption.textContent = `${scheme.name}${select.value ? '' : ' · inherited from Global Options'} — ANSI preview`;
    preview.refresh();
  };
  select.addEventListener('change', refresh);
  refresh();
  return {
    element, refresh, dispose: preview.dispose,
    destroy() { select.removeEventListener('change', refresh); preview.destroy(); element.remove(); },
  };
}

/** The draft remains local to this dialog until saveSettings succeeds. */
export function createColorPicker({ getSettings, saveSettings }) {
  const dialog = make('dialog', 'modal color-scheme-modal'); dialog.id = 'color-scheme-dialog';
  dialog.setAttribute('aria-labelledby', 'color-scheme-title');
  dialog.setAttribute('aria-describedby', 'color-scheme-note');
  const form = make('form', 'color-scheme-form');
  const header = make('header', 'modal-header');
  const title = make('h2', '', 'Color Schemes'); title.id = 'color-scheme-title';
  const close = make('button', 'icon-button', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close color schemes');
  header.append(title, close);
  const body = make('div', 'modal-body color-scheme-body');
  const choices = make('fieldset', 'color-scheme-choices');
  choices.append(make('legend', '', 'Default terminal scheme'));
  const grid = make('div', 'color-scheme-grid'); grid.id = 'color-scheme-grid';
  const radios = new Map();
  for (const scheme of COLOR_SCHEMES) {
    const card = make('label', 'color-scheme-card'); card.dataset.scheme = scheme.id;
    const radio = make('input'); radio.type = 'radio'; radio.name = 'termforge-color-scheme'; radio.value = scheme.id;
    const label = make('span', 'color-scheme-card-name', scheme.name);
    const thumbnail = make('span', 'color-scheme-thumbnail'); thumbnail.setAttribute('aria-hidden', 'true');
    thumbnail.style.backgroundColor = scheme.theme.background;
    thumbnail.style.color = scheme.theme.foreground;
    const prompt = make('span', 'color-scheme-mini-prompt', 'demo:~ $');
    const swatches = make('span', 'color-scheme-swatches');
    for (const key of ANSI_COLOR_KEYS) {
      const swatch = make('span'); swatch.style.backgroundColor = scheme.theme[key]; swatches.append(swatch);
    }
    thumbnail.append(prompt, swatches);
    card.append(radio, label, thumbnail); grid.append(card); radios.set(scheme.id, radio);
    radio.addEventListener('change', () => { if (radio.checked) { selectedId = scheme.id; refresh(); } });
  }
  choices.append(grid);
  const details = make('section', 'color-scheme-details');
  const schemeTitle = make('h3', 'color-scheme-selection-title');
  const description = make('p', 'color-scheme-description');
  const previewFrame = make('div', 'color-scheme-preview-frame');
  const previewBar = make('div', 'color-scheme-preview-bar', 'TermForge — sample session');
  const host = make('div', 'scheme-ansi-preview'); host.id = 'color-scheme-preview';
  previewFrame.append(previewBar, host);
  const sampleNote = make('p', 'field-note color-scheme-sample-note', 'Local ANSI sample. No connection is opened.');
  const matchLabel = make('label', 'option-check color-scheme-match');
  const match = make('input'); match.type = 'checkbox'; match.id = 'color-scheme-match-interface';
  matchLabel.append(match, document.createTextNode('Match interface to default scheme'));
  const matchNote = make('p', 'field-note', 'Also colors the toolbars, managers, and dialogs.');
  const note = make('p', 'field-note color-scheme-scope', 'Applies to terminals that use Global Options. Per-session color overrides are retained.'); note.id = 'color-scheme-note';
  const error = make('p', 'form-error'); error.id = 'color-scheme-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  details.append(schemeTitle, description, previewFrame, sampleNote, matchLabel, matchNote, note, error);
  body.append(choices, details);
  const footer = make('footer', 'modal-footer');
  const status = make('span', 'color-scheme-save-status'); status.setAttribute('role', 'status');
  const cancel = make('button', 'quiet-button', 'Cancel'); cancel.type = 'button'; cancel.id = 'color-scheme-cancel';
  const apply = make('button', 'primary-button', 'Apply'); apply.type = 'submit'; apply.id = 'color-scheme-apply';
  footer.append(status, cancel, apply); form.append(header, body, footer); dialog.append(form); document.body.append(dialog);
  let selectedId = 'traditional';
  let busy = false;
  let destroyed = false;
  let generation = 0;
  const preview = createAnsiPreview(host, () => resolveColorScheme(selectedId));

  function refresh() {
    const scheme = resolveColorScheme(selectedId);
    schemeTitle.textContent = scheme.name; description.textContent = scheme.description;
    for (const [id, radio] of radios) {
      radio.checked = id === scheme.id;
      radio.closest('label').classList.toggle('selected', radio.checked);
    }
    previewFrame.removeAttribute('style');
    if (match.checked) {
      for (const [key, value] of Object.entries(scheme.chrome)) previewFrame.style.setProperty(key, value);
      previewFrame.style.colorScheme = scheme.appearance;
    }
    preview.refresh();
  }
  function setBusy(value) {
    busy = value; apply.disabled = value; cancel.disabled = value; close.disabled = value;
    choices.disabled = value; match.disabled = value;
    form.setAttribute('aria-busy', String(value)); status.textContent = value ? 'Applying…' : '';
  }
  function dismiss() { if (!busy && dialog.open) dialog.close('cancel'); }
  close.addEventListener('click', dismiss); cancel.addEventListener('click', dismiss);
  match.addEventListener('change', refresh);
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    // A queued close event must not dispose a newly reopened dialog's preview.
    if (dialog.open) return;
    generation += 1; preview.dispose();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || destroyed) return;
    const attempt = generation;
    const patch = { colorScheme: selectedId, matchColorScheme: match.checked };
    error.hidden = true; error.textContent = ''; setBusy(true);
    try {
      await saveSettings(patch);
      if (!destroyed && generation === attempt && dialog.open) dialog.close('apply');
    } catch (failure) {
      if (!destroyed && generation === attempt && dialog.open) {
        error.textContent = failure?.message || 'Could not save the color scheme. Please try again.';
        error.hidden = false;
      }
    } finally {
      if (!destroyed) { setBusy(false); if (dialog.open && !error.hidden) apply.focus(); }
    }
  });
  return {
    open() {
      if (destroyed || busy || dialog.open) return;
      generation += 1;
      const settings = getSettings() || {};
      selectedId = resolveColorScheme(settings.colorScheme).id;
      match.checked = Boolean(settings.matchColorScheme);
      error.hidden = true; error.textContent = ''; setBusy(false);
      dialog.showModal(); refresh(); radios.get(selectedId)?.focus();
    },
    dispose() { destroyed = true; generation += 1; if (dialog.open) dialog.close(); preview.destroy(); dialog.remove(); },
  };
}
