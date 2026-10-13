'use strict';

const MODIFIERS = Object.freeze(['Ctrl', 'Alt', 'Shift', 'Meta']);
const NAMED_KEYS = Object.freeze(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Escape', 'Space']);
const MENU_ACTIONS = Object.freeze(['connect', 'disconnect', 'reconnect', 'local-shell', 'quick-connect', 'find', 'copy', 'paste', 'select-all', 'clear-screen', 'reset-terminal', 'sftp', 'snapshots', 'next-tab', 'previous-tab', 'tile', 'tile-horizontal', 'tile-vertical', 'tile-grid', 'group-vertical', 'group-horizontal', 'group-move-next', 'group-collapse', 'script-run']);

function normalizeKeyCombination(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Key combination must be text of at most 100 characters.');
  const parts = value.trim().split('+').map(part => part.trim());
  let main = parts.pop();
  const modifiers = parts.map(part => MODIFIERS.find(name => name.toLowerCase() === part.toLowerCase()));
  if (modifiers.some(part => !part) || new Set(modifiers).size !== modifiers.length) throw new Error('Use each Ctrl, Alt, Shift, or Meta modifier at most once.');
  if (/^[A-Za-z0-9]$/u.test(main)) main = main.toUpperCase();
  else if (/^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(main)) main = main.toUpperCase();
  else main = NAMED_KEYS.find(name => name.toLowerCase() === main.toLowerCase());
  if (!main) throw new Error('Choose a letter, digit, F1–F24, arrow, navigation key, Enter, Tab, Escape, Backspace, Delete, Insert, or Space.');
  return [...MODIFIERS.filter(name => modifiers.includes(name)), main].join('+');
}

function keyCombinationForEvent(event) {
  if (!event || (event.type && event.type !== 'keydown') || event.isComposing || event.key === 'Process' || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return null;
  let main = event.key;
  if (main === ' ' || main === 'Spacebar') main = 'Space';
  // Shift changes digits into punctuation. Option on macOS may turn a letter
  // into a composed character. Recover the base key for those combinations.
  if ((!main || !/^[A-Za-z0-9]$/u.test(main)) && /^Digit[0-9]$/u.test(event.code || '')) main = event.code.slice(5);
  if ((!main || !/^[A-Za-z0-9]$/u.test(main)) && (event.altKey || event.ctrlKey || event.metaKey) && /^Key[A-Z]$/u.test(event.code || '')) main = event.code.slice(3);
  const modifiers = MODIFIERS.filter(name => event[{ Ctrl: 'ctrlKey', Alt: 'altKey', Shift: 'shiftKey', Meta: 'metaKey' }[name]]);
  try { return normalizeKeyCombination([...modifiers, main || ''].join('+')); } catch { return null; }
}

function matchingMapping(event, mappings) {
  const combination = keyCombinationForEvent(event);
  if (!combination || !Array.isArray(mappings)) return null;
  return mappings.find(mapping => {
    try { return normalizeKeyCombination(mapping?.key) === combination; } catch { return false; }
  }) || null;
}

function decodeMappedText(text) {
  if (typeof text !== 'string' || text.length > 16384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('Mapped text must be at most 16384 characters; use escapes for control characters.');
  let result = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\\') { result += text[index]; continue; }
    const escaped = text[++index];
    if (escaped === undefined) throw new Error('Mapped text ends with an incomplete backslash escape. Use \\\\ for a literal backslash.');
    if (Object.hasOwn({ r: 1, n: 1, t: 1, e: 1, '\\': 1 }, escaped)) {
      result += { r: '\r', n: '\n', t: '\t', e: '\x1b', '\\': '\\' }[escaped];
    } else if (escaped === 'x') {
      const hex = text.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/iu.test(hex)) throw new Error('A \\x escape requires exactly two hexadecimal digits.');
      result += String.fromCharCode(Number.parseInt(hex, 16)); index += 2;
    } else throw new Error(`Unsupported escape \\${escaped}. Use \\r, \\n, \\t, \\e, \\xHH, or \\\\.`);
  }
  return result;
}

function validateMappings(mappings) {
  if (!Array.isArray(mappings) || mappings.length > 100) throw new Error('Mapped keys must contain at most 100 mappings.');
  const seen = new Set();
  return mappings.map((mapping, index) => {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error(`Mapping ${index + 1} must be an object.`);
    let key;
    try { key = normalizeKeyCombination(mapping.key); } catch (error) { throw new Error(`Mapping ${index + 1}: ${error.message}`); }
    if (seen.has(key)) throw new Error(`Mapping ${index + 1}: ${key} is already mapped.`);
    seen.add(key);
    if (!['send', 'menu'].includes(mapping.action)) throw new Error(`Mapping ${index + 1}: choose Send text or Menu action.`);
    if (typeof mapping.value !== 'string' || !mapping.value || mapping.value.length > 16384) throw new Error(`Mapping ${index + 1}: an action value is required, up to 16384 characters.`);
    if (mapping.action === 'menu' && !MENU_ACTIONS.includes(mapping.value)) throw new Error(`Mapping ${index + 1}: choose a supported menu action.`);
    if (mapping.action === 'send') {
      try { decodeMappedText(mapping.value); } catch (error) { throw new Error(`Mapping ${index + 1}: ${error.message}`); }
    }
    return { key, action: mapping.action, value: mapping.value };
  });
}

module.exports = { MENU_ACTIONS, normalizeKeyCombination, keyCombinationForEvent, matchingMapping, decodeMappedText, validateMappings };
