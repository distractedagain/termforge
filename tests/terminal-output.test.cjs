'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOutputFile, createTextFilter } = require('../app/terminal-output.cjs');

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-output-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true })); return value;
}

test('text transcripts strip fragmented CSI, OSC, DCS, C1, ESC and control bytes without retaining hidden payloads', () => {
  const filter = createTextFilter();
  const input = 'Hi\x1b[31m red\x1b[0m\x1b]0;hidden title\x07!\x1bPignored\x1b\\\x1b(B\x9b32m\x9dsecret\x9cλ\x00\b\x7f\r\n\tend';
  let result = '';
  for (const char of input) result += filter.write(char);
  assert.equal(result, 'Hi red!λ\r\n\tend');
  assert.equal(filter.write('\x1b[123\x18visible'), 'visible');
  assert.equal(filter.write('\x1b]title\x1acanceled'), 'canceled');
});

test('plain output is a transcript, preserves line endings and Unicode without rendering cursor operations', t => {
  const file = path.join(directory(t), 'plain.log'), output = createOutputFile(file);
  output.write('line 1\r\nλ\ttext\x1b[2K\rreplacement\n'); output.close(); output.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'line 1\r\nλ\ttext\rreplacement\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('pause retains escape parser state but excludes paused text from the file', t => {
  const file = path.join(directory(t), 'paused.log'), output = createOutputFile(file);
  output.write('before'); output.paused = true;
  output.write('not captured\x1b]secret'); output.paused = false;
  output.write('still hidden\x07after'); output.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'beforeafter');
});

test('raw output preserves every byte, including malformed UTF-8 and control sequences', t => {
  const file = path.join(directory(t), 'raw.bin'), output = createOutputFile(file, { mode: 'raw' });
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  for (const byte of bytes) output.write(Buffer.from([byte])); output.close();
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('output refuses existing files, links and invalid paths or modes', t => {
  const root = directory(t), file = path.join(root, 'keep.txt'); fs.writeFileSync(file, 'preserve');
  assert.throws(() => createOutputFile(file), /EEXIST/);
  if (process.platform !== 'win32') { const link = path.join(root, 'linked'); fs.symlinkSync(file, link); assert.throws(() => createOutputFile(link), /EEXIST|ELOOP/); }
  assert.equal(fs.readFileSync(file, 'utf8'), 'preserve');
  assert.throws(() => createOutputFile('relative.log'), /absolute/);
  assert.throws(() => createOutputFile(path.join(root, 'bad'), { mode: 'other' }), /mode/);
});

test('output bounds apply to written bytes, permit empty filtered chunks, and do not write an overflowing chunk', t => {
  const file = path.join(directory(t), 'bounded.log'), output = createOutputFile(file, { maxBytes: 4 });
  output.write('λ'); output.write('\x1b[31m'); output.write('AB');
  assert.equal(output.bytes, 4); assert.throws(() => output.write('X'), error => error.code === 'OUTPUT_LIMIT');
  output.close(); assert.equal(fs.readFileSync(file, 'utf8'), 'λAB');
  assert.throws(() => output.write('after close'), /closed/);
});
