'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MENU_ACTIONS, normalizeKeyCombination, keyCombinationForEvent, matchingMapping, decodeMappedText, validateMappings } = require('../app/keymap.cjs');
const { validateSession } = require('../app/core.cjs');

test('mapped text decodes supported control/hex escapes and preserves Unicode and literal backslashes', () => {
  assert.equal(decodeMappedText(String.raw`show version\r\n\t\e[31m\x03\\λ 😀`), 'show version\r\n\t\x1b[31m\x03\\λ 😀');
  assert.equal(decodeMappedText(String.raw`\x00\x7f\xFF`), '\x00\x7fÿ');
  assert.equal(decodeMappedText('literal λ 😀 "quotes" \r\n\t'), 'literal λ 😀 "quotes" \r\n\t');
  const code = "'); globalThis.keymapInjected = true; ('";
  delete globalThis.keymapInjected;
  assert.equal(decodeMappedText(code), code);
  assert.equal(globalThis.keymapInjected, undefined);
});

test('malformed and unsupported escapes fail without evaluating text', () => {
  for (const text of ['\\', String.raw`\x`, String.raw`\x1`, String.raw`\xGG`, String.raw`\q`, String.raw`\u0041`, String.raw`\0`]) assert.throws(() => decodeMappedText(text), /escape/i);
  assert.throws(() => decodeMappedText('\x1bactual-escape'), /control/);
  assert.throws(() => decodeMappedText('\0'), /control/);
  assert.throws(() => decodeMappedText('x'.repeat(16385)), /16384/);
  assert.throws(() => decodeMappedText(42), /text/);
});

test('combinations normalize modifier order/case and reject ambiguous unsupported keys', () => {
  assert.equal(normalizeKeyCombination(' meta + shift + alt + ctrl + a '), 'Ctrl+Alt+Shift+Meta+A');
  assert.equal(normalizeKeyCombination('f24'), 'F24');
  assert.equal(normalizeKeyCombination('Ctrl+ArrowLeft'), 'Ctrl+ArrowLeft');
  assert.equal(normalizeKeyCombination('Space'), 'Space');
  for (const value of ['', 'Ctrl+Ctrl+A', 'Ctrl+control+A', 'Super+A', 'Ctrl++', 'F25', 'F0', 'Ctrl+λ', 'Ctrl+Numpad1']) assert.throws(() => normalizeKeyCombination(value));
});

test('matching requires exactly the specified modifiers and handles macOS Option and shifted digit keys', () => {
  const plain = { key: 'A', action: 'send', value: 'a' };
  const control = { key: 'Ctrl+A', action: 'send', value: 'control' };
  const all = { key: 'Ctrl+Alt+Shift+Meta+A', action: 'send', value: 'all' };
  const option = { key: 'Alt+A', action: 'send', value: 'option' };
  const digit = { key: 'Shift+1', action: 'send', value: 'digit' };
  const mappings = [plain, control, all, option, digit];
  assert.equal(matchingMapping({ type: 'keydown', key: 'a' }, mappings), plain);
  assert.equal(matchingMapping({ type: 'keydown', key: 'A', ctrlKey: true }, mappings), control);
  assert.equal(matchingMapping({ key: 'a', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }, mappings), all);
  assert.equal(matchingMapping({ key: 'å', code: 'KeyA', altKey: true }, mappings), option);
  assert.equal(matchingMapping({ key: '!', code: 'Digit1', shiftKey: true }, mappings), digit);
  assert.equal(matchingMapping({ key: 'a', ctrlKey: true, shiftKey: true }, mappings), null);
  assert.equal(keyCombinationForEvent({ key: ' ', altKey: true }), 'Alt+Space');
  assert.equal(keyCombinationForEvent({ key: 'ArrowDown', metaKey: true }), 'Meta+ArrowDown');
});

test('keyup, composition, AltGraph and modifier-only events do not fire mapped actions', () => {
  const mappings = [{ key: 'Ctrl+Alt+A', action: 'send', value: 'command' }];
  for (const event of [
    { type: 'keyup', key: 'a', ctrlKey: true, altKey: true },
    { key: 'a', ctrlKey: true, altKey: true, isComposing: true },
    { key: 'a', ctrlKey: true, altKey: true, keyCode: 229 },
    { key: 'a', ctrlKey: true, altKey: true, getModifierState: name => name === 'AltGraph' },
    { key: 'Control', ctrlKey: true }, { key: 'Shift', shiftKey: true },
  ]) assert.equal(matchingMapping(event, mappings), null);
  assert.equal(matchingMapping({ key: 'a' }, [{ key: null }, null]), null);
});

test('mapping validation rejects duplicates, invalid values and excess rows while matching core menu actions', () => {
  assert.deepEqual(validateMappings([{ key: 'shift+ctrl+a', action: 'send', value: String.raw`text\r` }]), [{ key: 'Ctrl+Shift+A', action: 'send', value: String.raw`text\r` }]);
  assert.throws(() => validateMappings([{ key: 'ctrl+a', action: 'send', value: 'x' }, { key: 'Ctrl+A', action: 'send', value: 'y' }]), /already mapped/);
  assert.throws(() => validateMappings([{ key: 'F1', action: 'send', value: String.raw`\q` }]), /Unsupported escape/);
  assert.throws(() => validateMappings([{ key: 'F1', action: 'menu', value: 'unknown' }]), /supported menu/);
  assert.throws(() => validateMappings([{ key: 'F1', action: 'send', value: '' }]), /required/);
  assert.throws(() => validateMappings(Array(101).fill({ key: 'F1', action: 'send', value: 'x' })), /100/);
  for (const value of MENU_ACTIONS) {
    const mapping = { key: 'Ctrl+F1', action: 'menu', value };
    assert.deepEqual(validateSession({ protocol: 'local', terminal: { mappedKeys: validateMappings([mapping]) } }).terminal.mappedKeys, [mapping]);
  }
});
