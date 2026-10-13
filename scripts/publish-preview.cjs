'use strict';

// This intentionally has no npm dependencies and never starts Electron.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?![\s\S])/;
const PLATFORMS = [
  { label: 'macOS-arm64', platform: 'darwin', arch: 'arm64', slug: 'macos-arm64', extensions: ['dmg', 'zip'] },
  { label: 'macOS-x64', platform: 'darwin', arch: 'x64', slug: 'macos-x64', extensions: ['dmg', 'zip'] },
  { label: 'Windows-x64', platform: 'win32', arch: 'x64', slug: 'windows-x64', extensions: ['exe', 'exe'] },
  { label: 'Linux-x64', platform: 'linux', arch: 'x64', slug: 'linux-x64', extensions: ['AppImage', 'deb'] },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateInputs(env) {
  assert(env.GITHUB_ACTIONS === 'true', 'Publisher can run only inside GitHub Actions.');
  assert(env.GITHUB_SERVER_URL === 'https://github.com' && env.GITHUB_API_URL === 'https://api.github.com', 'Expected GitHub.com Actions context.');
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/.test(env.GITHUB_REPOSITORY || ''), 'Invalid repository context.');
  assert(/^[1-9]\d*(?![\s\S])/.test(env.SOURCE_RUN_ID || ''), 'run_id must be a positive integer string.');
  assert((env.RELEASE_TAG || '').startsWith('v') && SEMVER.test(env.RELEASE_TAG.slice(1)), 'tag must be v followed by a strict semantic version.');
  assert(env.GH_TOKEN, 'Missing GitHub Actions token.');
  assert(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP), 'Missing absolute runner temporary directory.');
  return { repository: env.GITHUB_REPOSITORY, runId: env.SOURCE_RUN_ID, tag: env.RELEASE_TAG, version: env.RELEASE_TAG.slice(1) };
}

function validateRun(run, repository, runId) {
  assert(String(run.id) === runId, 'Source run ID mismatch.');
  const matches = name => typeof name === 'string' && name.toLowerCase() === repository.toLowerCase();
  assert(matches(run.repository?.full_name) && matches(run.head_repository?.full_name), 'Source run must belong to this repository, including its head repository.');
  assert(run.repository.id === run.head_repository.id, 'Source run head repository ID mismatch.');
  assert(run.path === '.github/workflows/release.yml', 'Source run is not the build release workflow.');
  assert(run.event === 'workflow_dispatch', 'Source build must have been dispatched manually.');
  assert(run.status === 'completed' && run.conclusion === 'success', 'All source build jobs must have completed successfully.');
  assert(/^[0-9a-f]{40}(?![\s\S])/.test(run.head_sha || ''), 'Invalid source commit SHA.');
  return run.head_sha;
}

function validateArtifacts(artifacts) {
  assert(Array.isArray(artifacts) && artifacts.length === PLATFORMS.length, 'Expected exactly four platform build artifacts.');
  const expected = PLATFORMS.map(spec => `termforge-${spec.label}-public-preview`);
  const names = new Set();
  for (const artifact of artifacts) {
    assert(expected.includes(artifact.name) && !names.has(artifact.name), 'Unexpected or duplicate platform artifact.');
    assert(artifact.expired === false && artifact.size_in_bytes > 0, `Artifact ${artifact.name} is expired or empty.`);
    names.add(artifact.name);
  }
}

function safeFilename(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && name !== '.' && name !== '..' && !name.startsWith('-') && !/[\\/\x00-\x1f\x7f]/.test(name) && path.basename(name) === name;
}

function parseChecksums(contents) {
  const entries = new Map();
  const lines = contents.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  assert(lines.length > 0, 'Checksum manifest is empty.');
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert(match && safeFilename(match[2]), 'Checksum manifest must contain SHA-256 hashes and basename-only filenames.');
    assert(!entries.has(match[2]), 'Checksum manifest contains duplicate filenames.');
    assert(/\.(zip|dmg|exe|AppImage|deb|blockmap)$/.test(match[2]), 'Checksum manifest contains an unsupported build file.');
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function validateBuildInfo(info, spec, sha, version, files) {
  assert(info.name === 'ForgeCRT' && info.version === version && info.commit === sha, `Build provenance mismatch for ${spec.label}.`);
  assert(info.platform === spec.platform && info.architecture === spec.arch, `Platform/architecture mismatch for ${spec.label}.`);
  assert(info.backendUnitTestsPassed === true && info.rendererBuildPassed === true, `Required build checks did not pass for ${spec.label}.`);
  assert(info.desktopRuntimeTested === false, `Unexpected desktop runtime claim for ${spec.label}.`);
  assert(Array.isArray(info.files) && info.files.length === files.length && new Set(info.files).size === files.length && [...info.files].sort().every((name, index) => name === [...files].sort()[index]), `Build provenance file list mismatch for ${spec.label}.`);
  if (spec.platform === 'darwin') {
    assert(info.signing?.type === 'ad-hoc' && info.signing.signatureIntegrityVerified === true && info.signing.developerIdSigned === false && info.signing.notarized === false, `Expected verified ad-hoc, unnotarized macOS signature for ${spec.label}.`);
  }
}

function normalizedBinaryName(filename, spec, version) {
  assert(safeFilename(filename), 'Unsafe installer filename.');
  // electron-builder uses spaces in Windows names and underscores in Debian names.
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert(new RegExp(`(?:^|[- _])${escaped}(?:$|[- _.])`).test(filename), 'Installer filename does not match the selected version.');
  const extension = filename.split('.').at(-1);
  assert(spec.extensions.includes(extension), `Unexpected installer type for ${spec.label}.`);
  const stem = `ForgeCRT-${version}-${spec.slug}`;
  if (spec.platform === 'win32') return `${stem}-${/setup/i.test(filename) ? 'setup' : 'portable'}.exe`;
  return `${stem}.${extension}`;
}

async function verifyAndStage(directory, spec, sha, version, staging) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  assert(entries.every(entry => entry.isFile() && safeFilename(entry.name)), `Artifact ${spec.label} must contain only regular files at its root.`);
  const checksums = parseChecksums(await fsp.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8'));
  const expected = new Set(['SHA256SUMS.txt', 'BUILD_INFO.json', ...checksums.keys()]);
  assert(entries.length === expected.size && entries.every(entry => expected.has(entry.name)), `Artifact ${spec.label} has unlisted or missing files.`);
  for (const [filename, expectedHash] of checksums) {
    assert(await hashFile(path.join(directory, filename)) === expectedHash, `Checksum mismatch for ${spec.label}/${filename}.`);
  }
  const info = JSON.parse(await fsp.readFile(path.join(directory, 'BUILD_INFO.json'), 'utf8'));
  validateBuildInfo(info, spec, sha, version, [...checksums.keys()]);
  const binaries = [...checksums.keys()].filter(filename => !filename.endsWith('.blockmap'));
  assert(binaries.length === 2, `Expected two installers/archives for ${spec.label}.`);
  const assets = [];
  for (const filename of binaries) {
    const name = normalizedBinaryName(filename, spec, version);
    assert(!assets.some(asset => asset.name === name), `Duplicate installer target for ${spec.label}.`);
    const destination = path.join(staging, name);
    // Preserve each original package and its bundled licenses byte for byte.
    await fsp.copyFile(path.join(directory, filename), destination, fs.constants.COPYFILE_EXCL);
    assets.push({ name, path: destination, hash: checksums.get(filename), size: (await fsp.stat(destination)).size });
  }
  const name = `ForgeCRT-${version}-${spec.slug}-BUILD_INFO.json`;
  const destination = path.join(staging, name);
  await fsp.copyFile(path.join(directory, 'BUILD_INFO.json'), destination, fs.constants.COPYFILE_EXCL);
  assets.push({ name, path: destination, hash: await hashFile(destination), size: (await fsp.stat(destination)).size });
  return assets;
}

async function execute(command, args, options) {
  return execFileAsync(command, args, { ...options, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function releaseStateDiagnostic(release) {
  const value = release && typeof release === 'object' ? release : {};
  return JSON.stringify({
    id: Number.isSafeInteger(value.id) ? value.id : null,
    tag: typeof value.tag_name === 'string' ? value.tag_name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) : null,
    draft: typeof value.draft === 'boolean' ? value.draft : null,
    prerelease: typeof value.prerelease === 'boolean' ? value.prerelease : null,
  });
}

async function main({ env = process.env, runCommand = execute } = {}) {
  const { repository, runId, tag, version } = validateInputs(env);
  const gh = async args => (await runCommand('gh', args, { env })).stdout;
  const api = async route => JSON.parse(await gh(['api', route]));
  const optionalApi = async route => {
    try { return await api(route); }
    catch (error) {
      if (/\(HTTP 404\)/.test(error.stderr || '')) return null;
      throw new Error('GitHub API lookup failed; publication stopped.');
    }
  };
  const sha = validateRun(await api(`repos/${repository}/actions/runs/${runId}`), repository, runId);
  const packageText = (await runCommand('git', ['show', `${sha}:package.json`], { env })).stdout;
  const packageInfo = JSON.parse(packageText);
  assert(SEMVER.test(packageInfo.version || '') && packageInfo.version === version, 'Release tag must match package.json at the source build commit.');
  const pages = JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`]));
  assert(Array.isArray(pages) && pages.every(page => Array.isArray(page.artifacts)), 'Invalid artifact API response.');
  validateArtifacts(pages.flatMap(page => page.artifacts));
  const releaseForTag = async () => {
    // The tag endpoint documents published releases; list also includes drafts
    // for this job's token, which has repository push access.
    const releasePages = JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]));
    assert(Array.isArray(releasePages) && releasePages.every(Array.isArray), 'Invalid releases API response.');
    const matches = releasePages.flat().filter(release => release.tag_name === tag);
    assert(matches.length <= 1, 'Duplicate releases exist for this tag.');
    return matches[0] || null;
  };
  assert(!await releaseForTag(), 'A release already exists for this tag; refusing to overwrite it.');
  const checkTag = async () => {
    const ref = await optionalApi(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
    assert(ref, 'Release tag must already exist at the original build commit; create it with an authorized account before dispatch.');
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) object = (await api(`repos/${repository}/git/tags/${object.sha}`)).object;
    assert(object?.type === 'commit' && object.sha === sha, 'Existing tag does not point to the original build commit.');
  };
  await checkTag();
  const notesFile = path.resolve('docs', `RELEASE-${tag}.md`);
  const notes = await fsp.readFile(notesFile, 'utf8');
  assert(notes.trim().length > 0 && Buffer.byteLength(notes) <= 100000, 'Release notes are missing, empty, or too large.');
  const temporary = await fsp.mkdtemp(path.join(env.RUNNER_TEMP, 'termforge-publish-'));
  const staging = path.join(temporary, 'release-assets');
  await fsp.mkdir(staging);
  const assets = [];
  for (const spec of PLATFORMS) {
    const directory = path.join(temporary, spec.slug);
    await fsp.mkdir(directory);
    await gh(['run', 'download', runId, '--repo', repository, '--name', `termforge-${spec.label}-public-preview`, '--dir', directory]);
    assets.push(...await verifyAndStage(directory, spec, sha, version, staging));
  }
  const expectedNames = PLATFORMS.flatMap(spec => spec.platform === 'win32'
    ? [`ForgeCRT-${version}-${spec.slug}-setup.exe`, `ForgeCRT-${version}-${spec.slug}-portable.exe`]
    : spec.extensions.map(extension => `ForgeCRT-${version}-${spec.slug}.${extension}`));
  assert(expectedNames.length === 8 && expectedNames.every(name => assets.some(asset => asset.name === name)), 'The eight expected binary targets are not all present.');
  assert(assets.length === 12 && new Set(assets.map(asset => asset.name)).size === assets.length, 'Missing or duplicate final release assets.');
  assets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const checksumPath = path.join(staging, 'SHA256SUMS.txt');
  await fsp.writeFile(checksumPath, assets.map(asset => `${asset.hash}  ${asset.name}`).join('\n') + '\n', { flag: 'wx' });
  assets.push({ name: 'SHA256SUMS.txt', path: checksumPath, hash: await hashFile(checksumPath), size: (await fsp.stat(checksumPath)).size });
  // Create privately only after every platform is validated. Failed uploads leave a draft.
  // The tag is already bound to the build SHA. Do not ask GITHUB_TOKEN to create
  // an older workflow-bearing ref, and do not use target_commitish as provenance:
  // GitHub ignores it when a tag exists and can report the default branch here.
  await checkTag();
  const creationPayload = path.join(temporary, 'create-release.json');
  await fsp.writeFile(creationPayload, JSON.stringify({
    tag_name: tag,
    name: `ForgeCRT ${tag} — public preview`,
    body: notes,
    draft: true,
    prerelease: true,
  }), { flag: 'wx' });
  // Use the creation response directly: the release list can lag behind a
  // newly created draft. All subsequent release reads use this returned ID.
  const created = JSON.parse(await gh(['api', '--method', 'POST', `repos/${repository}/releases`, '--input', creationPayload]));
  assert(created && Number.isSafeInteger(created.id) && created.id > 0 && created.tag_name === tag && created.draft === true && created.prerelease === true, `Created draft provenance mismatch ${releaseStateDiagnostic(created)}; leaving it private.`);
  await checkTag();
  const releaseRoute = `repos/${repository}/releases/${created.id}`;
  await gh(['release', 'upload', tag, '--repo', repository, ...assets.map(asset => asset.path)]);
  const draft = await api(releaseRoute);
  assert(draft.tag_name === tag && draft.draft === true && draft.prerelease === true, 'Draft release provenance mismatch; leaving it private.');
  assert(Array.isArray(draft.assets) && draft.assets.length === assets.length, 'Incomplete draft upload; leaving it private.');
  for (const asset of assets) {
    const matches = draft.assets.filter(upload => upload.name === asset.name);
    assert(matches.length === 1 && matches[0].state === 'uploaded' && matches[0].size === asset.size, 'Draft asset upload mismatch; leaving it private.');
    if (matches[0].digest) assert(matches[0].digest === `sha256:${asset.hash}`, 'Uploaded asset digest mismatch; leaving the draft private.');
  }
  await checkTag();
  await gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=true']);
  const published = await api(releaseRoute);
  assert(published.tag_name === tag && published.draft === false && published.prerelease === true, 'Cannot confirm the final published release state.');
  await checkTag();
  const url = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
  assert(published.html_url === url, 'Unexpected published release URL.');
  if (env.GITHUB_OUTPUT) await fsp.appendFile(env.GITHUB_OUTPUT, `release_url=${url}\ncommit=${sha}\n`);
  if (env.GITHUB_STEP_SUMMARY) await fsp.appendFile(env.GITHUB_STEP_SUMMARY, `Published [ForgeCRT ${tag}](${url}) from commit \`${sha}\`.\n\nAll eight binary packages, four build-provenance files, and combined SHA-256 checksums were verified. Desktop runtime testing remains pending; macOS builds use ad-hoc signatures and are unnotarized.\n`);
  process.stdout.write(`Published public preview: ${url}\n`);
  return { url, sha, assets: assets.map(asset => asset.name) };
}

if (require.main === module) {
  main().catch(error => {
    // Never emit command stderr or token-bearing environment values.
    let message = error instanceof Error ? error.message : 'Unknown publisher failure.';
    for (const secret of [process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter(Boolean)) message = message.split(secret).join('[redacted]');
    process.stderr.write(`Publication stopped: ${message}\nAny draft already created is left unpublished.\n`);
    process.exitCode = 1;
  });
}

module.exports = { SEMVER, PLATFORMS, validateInputs, validateRun, validateArtifacts, safeFilename, parseChecksums, hashFile, validateBuildInfo, normalizedBinaryName, verifyAndStage, releaseStateDiagnostic, main };
