# TermForge 0.15.0 verification

Status: local implementation and regression checks passed; platform CI, native Linux IPC and packaging verification are pending. Version 0.14.0 remains the last verified published release until those checks and publication complete.

## Scope

Durable individual-file SFTP pause/resume; reviewed folder merging; one-way content synchronization retaining destination-only entries; bounded UTF-8 remote editing with native save approval and conflict detection. See [workflow details and limits](SECURE-CONNECTIONS.md).

## Local evidence

- The complete backend suite passed 473 tests with zero failures/skips using bounded local concurrency. Two subsequently added final-hash shutdown regressions also passed, bringing the recovery suite to 30 tests. New coverage includes those 30 recovery tests, 38 folder/merge/synchronization tests, 14 remote editor unit tests and nine real SSH/SFTP remote editor tests.
- 108 main interface checks and 23 new transfer-workflow interface checks passed in headless Chromium. The targeted credential/transfer, remote-operation and folder suites also passed (23, 17 and 19 checks respectively). These use synthetic bridges.
- The remote editor light/narrow and dark/wide screenshots were inspected. The editor presents original and proposed contents before save.
- Renderer build and diff validation passed. Production dependency audit reported zero vulnerabilities.
- Independent review fixed review-expiry enforcement, lost-OPEN diagnostics, staged-text verification, permission preservation, multi-retained resume exclusion, stale-disconnect cleanup and misleading synchronization policy text.

## Evidence boundaries

Backend fixtures use temporary files and actual loopback SSH/SFTP connections where specified. Headless Chromium uses synthetic bridges. Real Electron IPC is exercised only in Linux CI using isolated profiles, synthetic credentials and injected native confirmation replies; no Electron window is launched on the development laptop. OS-dialog interaction by a human, installed application workflows, external servers and the full platform credential-store matrix require separate verification.

Full SecureFX behavior has not been reverse engineered. These are independently implemented workflows. SFTP v3 cannot prove remote inode identity or eliminate path races. Folder updates are a sequence of commits, and uncertain acknowledgements can leave staging/recovery files. macOS previews are ad-hoc signed without notarization; Windows previews are unsigned.
