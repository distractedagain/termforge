'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PLATFORMS, validateArtifacts, validateBuildInfo, normalizedBinaryName, verifyAndStage, hashFile } = require('../scripts/publish-preview.cjs');
const version = '0.16.0'; const sha = 'a'.repeat(40);
function info(spec, files) { return { name: 'ForgeCRT', version, commit: sha, platform: spec.platform, architecture: spec.arch,
  backendUnitTestsPassed: true, rendererBuildPassed: true, desktopRuntimeTested: false, files,
  ...(spec.platform === 'darwin' ? { signing: { type: 'ad-hoc', signatureIntegrityVerified: true, developerIdSigned: false, notarized: false } } : {}) }; }

test('ForgeCRT packages retain TermForge application and artifact identities for upgrades', () => {
  const metadata = require('../package.json');
  assert.equal(metadata.productName, 'ForgeCRT'); assert.equal(metadata.build.productName, 'ForgeCRT');
  assert.equal(metadata.name, 'termforge'); assert.equal(metadata.build.appId, 'org.termforge.desktop');
  assert.equal(metadata.build.linux.executableName, 'termforge'); assert.equal(metadata.desktopName, 'termforge.desktop');
  assert.equal(metadata.repository.url, 'https://github.com/distractedagain/termforge.git');
  validateArtifacts(PLATFORMS.map(spec => ({ name: `termforge-${spec.label}-public-preview`, expired: false, size_in_bytes: 1 })));
  assert.throws(() => validateArtifacts(PLATFORMS.map(spec => ({ name: `forgecrt-${spec.label}-public-preview`, expired: false, size_in_bytes: 1 }))), /Unexpected/);
});

test('publisher requires ForgeCRT provenance without accepting old branded records or false signing claims', () => {
  const spec = PLATFORMS[0]; const expected = info(spec, ['ForgeCRT-0.16.0.dmg', 'ForgeCRT-0.16.0.zip']);
  validateBuildInfo(expected, spec, sha, version, expected.files);
  for (const patch of [{ name: 'TermForge' }, { commit: 'b'.repeat(40) }, { version: '0.15.0' }, { desktopRuntimeTested: true }, { backendUnitTestsPassed: false }]) {
    assert.throws(() => validateBuildInfo({ ...expected, ...patch }, spec, sha, version, expected.files));
  }
  assert.throws(() => validateBuildInfo({ ...expected, signing: { ...expected.signing, notarized: true } }, spec, sha, version, expected.files));
});

for (const spec of PLATFORMS) test(`publisher validates hashes and preserves ${spec.label} bytes while naming ForgeCRT assets`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termforge-publisher-')); const input = path.join(directory, 'input'); const output = path.join(directory, 'output');
  await fs.mkdir(input); await fs.mkdir(output); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = spec.platform === 'win32' ? [`ForgeCRT Setup ${version}.exe`, `ForgeCRT ${version}.exe`]
    : spec.extensions.map(ext => ext === 'deb' ? `termforge_${version}_amd64.deb` : `ForgeCRT-${version}.${ext}`);
  const records = [];
  for (const [index, name] of files.entries()) { await fs.writeFile(path.join(input, name), Buffer.from(`synthetic-package-${spec.label}-${index}`)); records.push(`${await hashFile(path.join(input, name))}  ${name}`); }
  await fs.writeFile(path.join(input, 'SHA256SUMS.txt'), records.join('\n') + '\n');
  await fs.writeFile(path.join(input, 'BUILD_INFO.json'), JSON.stringify(info(spec, files)));
  const assets = await verifyAndStage(input, spec, sha, version, output);
  assert.equal(assets.length, 3); assert(assets.every(asset => asset.name.startsWith(`ForgeCRT-${version}-${spec.slug}`)));
  for (const name of files) assert.deepEqual(await fs.readFile(path.join(input, name)), await fs.readFile(path.join(output, normalizedBinaryName(name, spec, version))));
  assert(assets.some(asset => asset.name.endsWith('-BUILD_INFO.json')));
  const tamperedOutput = path.join(directory, 'tampered'); await fs.mkdir(tamperedOutput); await fs.appendFile(path.join(input, files[0]), 'tampered');
  await assert.rejects(verifyAndStage(input, spec, sha, version, tamperedOutput), /Checksum mismatch/); assert.deepEqual(await fs.readdir(tamperedOutput), []);
});
