'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COLOR_SCHEMES, COLOR_SCHEME_IDS, DEFAULT_COLOR_SCHEME, ANSI_COLOR_KEYS, resolveColorScheme } = require('../app/color-schemes.cjs');
const { validateSettings, validateSession, createStore } = require('../app/core.cjs');

function luminance(hex) {
  const channels = hex.slice(1).match(/../gu).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first, second) {
  const a = luminance(first); const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-palettes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, filename: path.join(directory, 'config.json'), store: createStore(directory) };
}

test('every selectable palette supplies a complete immutable terminal and matching interface', () => {
  assert.equal(COLOR_SCHEMES.length, 7);
  assert.deepEqual(COLOR_SCHEME_IDS, COLOR_SCHEMES.map(scheme => scheme.id));
  assert.equal(new Set(COLOR_SCHEME_IDS).size, COLOR_SCHEMES.length);
  const terminalKeys = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground', 'selectionInactiveBackground', ...ANSI_COLOR_KEYS];
  const chromeKeys = ['--chrome', '--panel', '--field', '--border', '--border-soft', '--text', '--muted', '--hover', '--select', '--accent', '--terminal'];
  for (const scheme of COLOR_SCHEMES) {
    assert.match(scheme.id, /^[a-z]+(?:-[a-z]+)*$/u);
    assert.ok(scheme.name && scheme.description);
    assert.ok(['dark', 'light'].includes(scheme.appearance));
    assert.deepEqual(Object.keys(scheme.theme).sort(), [...terminalKeys].sort(), scheme.id);
    assert.deepEqual(Object.keys(scheme.chrome).sort(), [...chromeKeys].sort(), scheme.id);
    for (const value of [...Object.values(scheme.theme), ...Object.values(scheme.chrome)]) assert.match(value, /^#[0-9a-f]{6}$/u, `${scheme.id}: ${value}`);
    assert.equal(scheme.chrome['--terminal'], scheme.theme.background);
    assert.ok(Object.isFrozen(scheme) && Object.isFrozen(scheme.theme) && Object.isFrozen(scheme.chrome));
  }
  assert.ok(Object.isFrozen(COLOR_SCHEMES) && Object.isFrozen(COLOR_SCHEME_IDS) && Object.isFrozen(ANSI_COLOR_KEYS));
  assert.throws(() => { resolveColorScheme('solarized-dark').theme.background = '#ffffff'; }, TypeError);
});

test('Solarized uses the canonical ANSI slots and light/dark base, cursor, and selection pairs', () => {
  // Reference: Ethan Schoonover's Solarized sRGB/16-color table. ANSI bright
  // black is base03, not base01; applications use these slots as base colors.
  const expectedAnsi = ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'];
  for (const id of ['solarized-dark', 'solarized-light']) assert.deepEqual(ANSI_COLOR_KEYS.map(key => resolveColorScheme(id).theme[key]), expectedAnsi);
  const dark = resolveColorScheme('solarized-dark').theme;
  const light = resolveColorScheme('solarized-light').theme;
  assert.deepEqual([dark.background, dark.foreground, dark.cursor, dark.cursorAccent], ['#002b36', '#839496', '#839496', '#002b36']);
  assert.deepEqual([light.background, light.foreground, light.cursor, light.cursorAccent], ['#fdf6e3', '#657b83', '#657b83', '#fdf6e3']);
  assert.deepEqual([dark.selectionBackground, dark.selectionForeground], ['#073642', '#93a1a1']);
  assert.deepEqual([light.selectionBackground, light.selectionForeground], ['#eee8d5', '#586e75']);
});

test('foreground, block cursor, and selected text remain readable in both light and dark palettes', () => {
  for (const { id, theme } of COLOR_SCHEMES) {
    // Canonical Solarized Light deliberately has about 4.13:1 body contrast.
    // Preserve the authored values rather than silently altering the palette.
    for (const [first, second] of [['foreground', 'background'], ['cursor', 'background'], ['cursor', 'cursorAccent'], ['selectionForeground', 'selectionBackground'], ['selectionForeground', 'selectionInactiveBackground']]) {
      assert.ok(contrast(theme[first], theme[second]) >= 4, `${id}: ${first}/${second}`);
    }
  }
  const high = resolveColorScheme('high-contrast').theme;
  assert.equal(contrast(high.foreground, high.background), 21);
  for (const key of ANSI_COLOR_KEYS) assert.ok(contrast(high[key], high.background) >= 4.5, `High Contrast ${key}`);
});

test('Monochrome renders both normal and bright ANSI colors in grayscale', () => {
  const theme = resolveColorScheme('monochrome').theme;
  for (const key of ANSI_COLOR_KEYS) {
    const color = theme[key];
    assert.equal(color.slice(1, 3), color.slice(3, 5), key);
    assert.equal(color.slice(3, 5), color.slice(5, 7), key);
  }
});

test('palette resolution preserves explicit session choices, inheritance, and safe fallback', () => {
  assert.equal(DEFAULT_COLOR_SCHEME, 'traditional');
  assert.equal(resolveColorScheme('forge-light', 'solarized-dark').id, 'forge-light');
  for (const inherited of ['', undefined, null, 'missing', '__proto__', 'constructor', {}, 1]) assert.equal(resolveColorScheme(inherited, 'solarized-light').id, 'solarized-light');
  for (const invalid of ['', null, 'missing', '__proto__', {}, 1]) assert.equal(resolveColorScheme('', invalid).id, 'traditional');
  assert.equal(resolveColorScheme().id, 'traditional');
});

test('configuration validation accepts the shared catalogue and strictly validates optional interface matching', () => {
  for (const id of COLOR_SCHEME_IDS) {
    assert.equal(validateSettings({ colorScheme: id }).colorScheme, id);
    assert.equal(validateSession({ protocol: 'local', terminal: { colorScheme: id } }).terminal.colorScheme, id);
  }
  assert.equal(validateSession({ protocol: 'local', terminal: { colorScheme: '' } }).terminal.colorScheme, '');
  assert.equal(validateSettings().matchColorScheme, false);
  assert.equal(validateSettings({ matchColorScheme: true }).matchColorScheme, true);
  assert.equal(validateSettings({ matchColorScheme: false }).matchColorScheme, false);
  for (const id of ['', 'solarized', '#002b36', 'constructor', null]) assert.throws(() => validateSettings({ colorScheme: id }), /Color scheme is invalid/u);
  for (const id of ['missing', null]) assert.throws(() => validateSession({ protocol: 'local', terminal: { colorScheme: id } }), /Session color scheme is invalid/u);
  for (const value of ['true', 1, null, {}, []]) assert.throws(() => validateSettings({ matchColorScheme: value }), /must be true or false/u);
});

test('existing version one and two palettes load without altering bytes or enabling interface matching', t => {
  const { filename, store } = fixture(t);
  for (const version of [1, 2]) {
    for (const id of ['traditional', 'monochrome', 'solarized-dark', 'solarized-light']) {
      const original = JSON.stringify({ version, sessions: [{ id: 'old', name: 'Saved shell', protocol: 'local', terminal: { colorScheme: id } }], settings: { theme: 'light', colorScheme: id }, snippets: [] });
      fs.writeFileSync(filename, original);
      const loaded = store.load();
      assert.equal(loaded.version, 2);
      assert.equal(loaded.settings.colorScheme, id);
      assert.equal(loaded.settings.theme, 'light');
      assert.equal(loaded.settings.matchColorScheme, false);
      assert.equal(loaded.sessions[0].terminal.colorScheme, id);
      assert.equal(fs.readFileSync(filename, 'utf8'), original);
    }
  }
});

test('saved palette, session inheritance, and interface preference survive export/import with atomic rejection', t => {
  const { filename, store } = fixture(t);
  store.saveSettings({ colorScheme: 'solarized-dark', matchColorScheme: true, theme: 'light' });
  store.saveSession({ id: 'inherit', name: 'Inherited shell', protocol: 'local' });
  store.saveSession({ id: 'override', name: 'Light shell', protocol: 'local', terminal: { colorScheme: 'forge-light' } });
  const saved = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.saveSettings({ matchColorScheme: 'true' }), /must be true or false/u);
  assert.equal(fs.readFileSync(filename, 'utf8'), saved);
  const destination = fixture(t).store;
  const imported = destination.importConfig(store.exportConfig());
  assert.equal(imported.settings.colorScheme, 'solarized-dark');
  assert.equal(imported.settings.matchColorScheme, true);
  assert.equal(imported.settings.theme, 'light');
  assert.equal(imported.sessions.find(session => session.id === 'inherit').terminal.colorScheme, '');
  assert.equal(imported.sessions.find(session => session.id === 'override').terminal.colorScheme, 'forge-light');
  destination.saveSettings({ matchColorScheme: false });
  assert.equal(destination.load().settings.colorScheme, 'solarized-dark');
  assert.equal(destination.load().settings.theme, 'light');
  assert.equal(destination.load().settings.matchColorScheme, false);
});
