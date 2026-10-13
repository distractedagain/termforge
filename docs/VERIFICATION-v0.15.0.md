# TermForge 0.15.0 verification

Status: all four source CI jobs, all four installer builds and the native Linux smoke passed at source `4b850a26f4c56b416406f1a939cbc115ad8318a9`. [Version 0.15.0 is published](https://github.com/distractedagain/termforge/releases/tag/v0.15.0), and anonymous public-asset verification passed.

## Scope

Durable individual-file SFTP pause/resume; reviewed folder merging; one-way content synchronization retaining destination-only entries; bounded UTF-8 remote editing with native save approval and conflict detection. See [workflow details and limits](SECURE-CONNECTIONS.md).

## Local evidence

- The complete backend suite passed 473 tests with zero failures/skips using bounded local concurrency. Two subsequently added final-hash shutdown regressions also passed, bringing the recovery suite to 30 tests. New coverage includes those 30 recovery tests, 38 folder/merge/synchronization tests, 14 remote editor unit tests and nine real SSH/SFTP remote editor tests.
- 108 main interface checks and 23 new transfer-workflow interface checks passed in headless Chromium. The targeted credential/transfer, remote-operation and folder suites also passed (23, 17 and 19 checks respectively). These use synthetic bridges.
- The remote editor light/narrow and dark/wide screenshots were inspected. The editor presents original and proposed contents before save.
- Renderer build and diff validation passed. Production dependency audit reported zero vulnerabilities.
- Independent review fixed review-expiry enforcement, lost-OPEN diagnostics, staged-text verification, permission preservation, multi-retained resume exclusion, stale-disconnect cleanup and misleading synchronization policy text.

## Platform and native evidence

All jobs in [source CI](https://github.com/distractedagain/termforge/actions/runs/38468985696) and [installer packaging](https://github.com/distractedagain/termforge/actions/runs/38468986542) passed at the exact source above.

- Both Macs and Linux each passed 475 backend tests with no failures/skips. Windows passed 460 with 15 expected POSIX/symlink-specific skips.
- Linux passed 284 interface checks: 108 main, 13 project, 23 credentials/transfers, 23 Quick Connect, 24 menus, nine key tools, 25 imports, 17 remote operations, 19 folder transfers and 23 new workflows.
- Both Macs and Linux passed seven real localhost Ansible checks each.
- Production dependency audits reported zero vulnerabilities. Both Mac builds passed strict recursive ad-hoc signature integrity checks.
- Real Electron main/preload IPC passed Linux smoke tests for folder merge, one-way synchronization, remote editing, SFTP pause/resume and offline download partial cleanup, alongside the previous terminal/project/menu/security checks.

The native fixture declined resume, discard and remote-save confirmations before testing acceptance. It checked exact final bytes after resuming a 2 MiB upload, checkpoint creation/removal, offline paused-download cleanup, merge skips, sync replacements, retained target-only files, remote-save revisions, one-use tokens and external-change conflicts. The saved `secure-native.json` sets `nativeFolderMerge`, `nativeContentSynchronization`, `nativeRemoteEditing`, `nativeRemoteEditConflictAndDecline`, `nativeResumableUpload`, `nativePausedDownloadDiscard` and `nativeRecoveryNativeDecline` to true. Replies to native confirmation dialogs were injected; a human did not operate those dialogs.

The Linux secure-storage backend was unavailable `basic_text`; the test verified refusal to save credentials. This is not evidence that Linux native vault storage succeeds. No Electron window was launched on the development laptop.

## Publication evidence

Tag `v0.15.0` points to tested source `4b850a26f4c56b416406f1a939cbc115ad8318a9`. The [publisher](https://github.com/distractedagain/termforge/actions/runs/38470019300) validated all four build artifacts, original package hashes and build records, then published eight installers/archives, four build records and `SHA256SUMS.txt`. Subsequent documentation commits do not change the tag or packaged source.

Anonymous verification on October 13, 2026 at 21:23 UTC confirmed public release ID `412121633`, the exact source tag, all thirteen assets and all twelve checksum entries. The manifest and four build records were downloaded without authentication and independently hashed. The eight installer hashes were compared with GitHub's recorded SHA-256 asset digests; installer bytes were not downloaded or independently rehashed by this public check.

## Evidence boundaries

Backend fixtures use temporary files and actual loopback SSH/SFTP connections where specified. Headless Chromium uses synthetic bridges. Real Electron IPC is exercised only in Linux CI using isolated profiles, synthetic credentials and injected native confirmation replies; no Electron window is launched on the development laptop. OS-dialog interaction by a human, installed application workflows, external servers and the full platform credential-store matrix require separate verification.

Full SecureFX behavior has not been reverse engineered. These are independently implemented workflows. SFTP v3 cannot prove remote inode identity or eliminate path races. Folder updates are a sequence of commits, and uncertain acknowledgements can leave staging/recovery files. macOS previews are ad-hoc signed without notarization; Windows previews are unsigned.
