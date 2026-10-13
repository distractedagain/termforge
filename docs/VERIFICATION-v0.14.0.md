# TermForge 0.14.0 verification

Status: all four platform CI jobs and all four installer builds passed at source `a7ce65724df024e152ee37d070e8a3ad7f9ea02f`. [Version 0.14.0 is published](https://github.com/distractedagain/termforge/releases/tag/v0.14.0), and anonymous public-asset verification passed.

## Scope

Reviewed SFTP folder upload/download, native approval, one-use review tokens, new-only destinations, bounded recursion, aggregate progress and partial-copy reporting. See [file transfers](SECURE-CONNECTIONS.md) for limits.

## Local checks

- 405 backend tests passed, zero failures/skips, using bounded local concurrency.
- 22 new folder-copy checks use actual loopback SSH/SFTP plus controlled filesystem/transport failures. They cover nested round trips, empty folders, source changes, destination conflicts, symlink ancestry, unsafe names, resource bounds, expiry/replay, global reservations, partial output, lost acknowledgements, cancellation and shutdown ownership.
- 108 main interface checks, 23 credential/transfer checks, 19 dedicated folder checks and 17 remote-operation checks passed. These are headless Chromium with synthetic bridges; they do not establish native IPC behavior.
- Renderer build and diff validation passed. Production dependency audit reported zero vulnerabilities.
- Independent source review found and resolved lost-acknowledgement status and pending-scan shutdown ownership issues. The reviewed folder dialog screenshot was visually inspected.

## Platform and native evidence

All jobs in [source CI](https://github.com/distractedagain/termforge/actions/runs/38464561880) and [installer packaging](https://github.com/distractedagain/termforge/actions/runs/38464601211) passed at the exact source above.

- Both Macs and Linux each passed 405 backend tests with zero skips/failures. Windows passed 396 with nine expected platform-specific skips.
- Linux passed 261 interface checks: 108 main, 13 project, 23 credentials/transfers, 23 Quick Connect, 24 menus, nine key tools, 25 imports, 17 remote operations and 19 folder-copy checks.
- Both Macs and Linux passed seven actual localhost Ansible checks each.
- All inspected production dependency audits reported zero vulnerabilities. Both Mac packages passed strict recursive ad-hoc signature integrity checks.
- Linux's real Electron smoke passed the existing SSH, terminal, clipboard, editor, menus and import checks, plus folder copying through the actual preload/main-process IPC.

The native folder fixture authenticated to an isolated loopback SFTP server, declined an initial native confirmation and confirmed that no destination was created, then uploaded and downloaded a nested tree containing an empty directory and zero-byte file. File contents, directory contents, completed counters and byte counts were checked independently. Used tokens could not start again, and a discarded review created no destination. The saved report records `nativeFolderRoundTrip=true` and `nativeFolderDeclineAndDiscard=true`. Native confirmation responses were synthetic, not human OS-dialog interaction.

The Linux credential provider was insecure `basic_text`; the smoke verified refusal to save credentials. It does not establish successful native secure-vault storage. No Electron window was launched on the development laptop.

## Publication evidence

The [publisher](https://github.com/distractedagain/termforge/actions/runs/38465618197) validated all four build artifacts, original package hashes and build records, then published eight installers/archives, four build records and `SHA256SUMS.txt`. Tag `v0.14.0` points to tested source `a7ce65724df024e152ee37d070e8a3ad7f9ea02f`; subsequent documentation commits do not change that tag.

Anonymous verification on October 13, 2026 at 20:49 UTC confirmed public release ID `412096671`, the exact source tag, all thirteen assets and all twelve checksum entries. The manifest and four build records were downloaded without authentication and independently hashed. The eight installer hashes were compared with GitHub's recorded SHA-256 asset digests; installer bytes were not downloaded or independently rehashed by this public check.

## Verification boundaries

Local backend fixtures and headless Chromium do not establish installed-app behavior. Native Electron testing runs only in Linux CI using isolated profiles, synthetic credentials and temporary loopback SFTP servers; the development laptop does not launch Electron. Native-dialog replies are injected by the smoke test.

Full SecureFX behavior has not been reverse engineered. Proprietary binaries, decompilation and artwork are not part of this repository or distribution. The folder-copy implementation was developed independently from application requirements and standard SFTP behavior.

External-server interoperability, interactive installed packages and all operating-system credential-store behaviors still need separate verification. SFTP v3 cannot eliminate remote path races or prove identity from equal metadata. macOS previews are ad-hoc signed without notarization; Windows previews are unsigned.
