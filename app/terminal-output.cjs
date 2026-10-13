'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 128 * 1024 * 1024;

// A streaming transcript filter, not a screen emulator. Keep printable text,
// tabs and line endings, dropping terminal control sequences even when they
// span chunks. No sequence content is retained or executed.
function createTextFilter() {
  let state = 'text';
  return {
    write(value) {
      let result = '';
      for (const char of value) {
        const code = char.codePointAt(0);
        if (code === 0x18 || code === 0x1a) { state = 'text'; continue; }
        if (state === 'string' || state === 'string-escape') {
          if (code === 0x9c || code === 7 || (state === 'string-escape' && char === '\\')) state = 'text';
          else state = code === 27 ? 'string-escape' : 'string';
          continue;
        }
        if (code === 27) { state = 'escape'; continue; }
        if (code === 0x9b) { state = 'csi'; continue; }
        if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { state = 'string'; continue; }
        if (state === 'escape') {
          if (char === '[') state = 'csi';
          else if (['P', 'X', ']', '^', '_'].includes(char)) state = 'string';
          else if (code >= 0x20 && code <= 0x2f) state = 'escape-intermediate';
          else state = 'text';
          continue;
        }
        if (state === 'escape-intermediate') { if (code >= 0x30 && code <= 0x7e) state = 'text'; continue; }
        if (state === 'csi') { if (code >= 0x40 && code <= 0x7e) state = 'text'; continue; }
        if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) result += char;
      }
      return result;
    },
  };
}

function createOutputFile(filename, { mode = 'text', maxBytes = MAX_LOG_BYTES } = {}) {
  if (!['text', 'raw'].includes(mode)) throw new Error('Output mode must be text or raw.');
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\u0000\r\n]/u.test(filename)) throw new Error('An absolute output log path is required.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_BYTES) throw new Error('Invalid output file size limit.');
  // Never overwrite an existing file or follow a symlink selected by mistake.
  let descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  const filter = createTextFilter();
  let bytes = 0;
  return {
    filename, mode, paused: false,
    get bytes() { return bytes; },
    write(value) {
      if (descriptor === null) throw new Error('Output file is closed.');
      const payload = mode === 'text' ? Buffer.from(filter.write(value), 'utf8') : value;
      // Keep the parser in sync while paused; resuming mid-OSC must not leak its
      // hidden payload into the plain-text transcript.
      if (this.paused) return;
      if (bytes + payload.length > maxBytes) { const error = new Error('Output file reached the 128 MiB limit.'); error.code = 'OUTPUT_LIMIT'; throw error; }
      let offset = 0;
      while (offset < payload.length) {
        const written = fs.writeSync(descriptor, payload, offset, payload.length - offset);
        if (!written) throw new Error('Output file could not be written.');
        offset += written; bytes += written;
      }
    },
    close() { if (descriptor !== null) { const value = descriptor; descriptor = null; fs.closeSync(value); } },
  };
}

module.exports = { createOutputFile, createTextFilter, MAX_LOG_BYTES };
