'use strict';
// Manually dispatched CI diagnostic. Only newly generated temporary fixture
// keys are used; no agent, personal key files, credentials or Electron windows.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { utils } = require('ssh2');
const { createKeyTools } = require('../app/key-tools.cjs');

async function main() {
  if (process.platform !== 'win32') { console.log('Windows-only diagnostic; skipped.'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termforge-key-diagnostic-'));
  const oldPhrase = 'old synthetic diagnostic passphrase', newPhrase = 'new synthetic diagnostic passphrase';
  const source = path.join(directory, 'source-key');
  try {
    await fs.writeFile(source, utils.generateKeyPairSync('ed25519', { cipher: 'aes256-cbc', passphrase: oldPhrase }).private);
    for (const operation of ['generate', 'convert']) {
      const destination = path.join(directory, `${operation}-key`);
      let output = '', outputBytes = 0, result, failure;
      const service = createKeyTools({ tempRoot: directory, timeoutMs: 15000,
        dialog: { showSaveDialog: async () => ({ filePath: destination }), showOpenDialog: async () => ({ filePaths: [source] }) },
        spawnPty(executable, args, options) {
          const child = require('node-pty').spawn(executable, args, options);
          child.onData(chunk => { outputBytes += Buffer.byteLength(chunk); if (outputBytes <= 32768) output += chunk; });
          return child;
        },
      });
      try {
        result = operation === 'generate'
          ? await service.generate({ type: 'ed25519', comment: 'synthetic diagnostic', passphrase: newPhrase })
          : await service.convert({ oldPassphrase: oldPhrase, newPassphrase: newPhrase });
      } catch (error) { failure = error.message; process.exitCode = 1; }
      finally { await service.close(); }
      // Concatenate before redaction so fragmented/echoed fixture text cannot
      // evade replacement. JSON escaping preserves ConPTY control sequences.
      for (const text of [oldPhrase, newPhrase, directory]) output = output.split(text).join('[fixture]');
      console.log(JSON.stringify({ operation, succeeded: Boolean(result && !result.canceled), encrypted: result?.encrypted, failure, outputBytes, syntheticConsoleOutput: output.slice(0, 4096) }));
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(() => { console.error('Synthetic Windows key diagnostic could not finish or clean up.'); process.exitCode = 1; });
