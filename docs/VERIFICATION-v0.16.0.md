# ForgeCRT 0.16.0 verification

Status: local validation completed; corrected platform CI, packaging, native Linux smoke and publication are pending. Version 0.15.0 remains the latest verified public release until those gates pass.

## Scope

ForgeCRT display-name transition; durable SFTP folder copy/merge/one-way synchronization recovery; actual initial SCP payload with verified SFTP recovery; explicit two-way conflict reconciliation; reviewed mirroring with target-only deletion; passive FTP and explicit/implicit FTPS file browsing and transfers.

## Local evidence

- Complete backend suite: 546 passed, zero failures/skips, bounded concurrency. A subsequent real-SFTP mirror regression also passed with 22 targeted mirror/two-way checks, bringing the final source suite to 547 tests.
- New protocol coverage includes 48 recovery tests, 61 folder tests and 25 FTP/FTPS tests. These use isolated temporary files and real loopback SSH/SFTP/FTP/TLS sockets where specified; SCP initial payload and resumed suffix are checked separately in both directions.
- All 300 headless interface checks passed: 242 across the eight existing main/project/security/Quick Connect/menu/key/import/remote-operation suites plus the 58 transfer checks below.
- Transfer UI suites passed 19 folder, 23 existing workflow and 16 new advanced workflow checks in headless Chromium. The advanced suite covers protocol capability gating, explicit conflict review, exact mirror deletions, folder/SCP recovery labels, early completion, queued FTP refresh, late connection-close events and narrow-window focus/layout.
- Renderer builds, syntax checks and diff validation passed. Production dependency audit found zero vulnerabilities.
- Independent reviews fixed disconnected FTP cleanup ownership, source/target validation order before mirror deletion, premature queue refresh, one-sided refresh after fast two-way completion and stale connection state after a close event raced the open reply.
- Wide dark conflict-review and narrow FTP-form screenshots were visually inspected. No Electron process was launched on the development laptop.

## Platform issues corrected before publication

Initial CI passed 547 backend tests on both Macs and Linux, plus all 300 Linux interface checks and seven localhost Ansible checks. Windows exposed large numeric filesystem identifiers in recovery metadata and a transient SCP staging-file lock; focused regression fixes passed 51 local recovery tests, including an opaque filesystem-ID fixture and transient/persistent lock cases. The final bounded SCP reopen checks also passed 3/3. The initial packaging hook referenced a nonexistent optional notice; it now packages the dependency’s actual LICENSE.txt, and the complete license-copy hook passes locally. The expanded native smoke reached successful folder recovery before its old two-minute suite timeout; its overall budget is now five minutes, with individual operation deadlines unchanged. No initial-run artifacts were published.

## Pending platform and publication evidence

All four source CI and installer packaging jobs must pass against one source commit before publishing. Linux native smoke adds folder recovery, two-way conflict decisions, mirror decline/apply, FTP/FTPS through real preload IPC and preserved storage-identity assertions. That smoke has been authored and syntax-checked but has not run locally. Public release hashes and provenance have not yet been verified for this version.

## Evidence boundaries

Headless UI uses a synthetic bridge. Native smoke uses isolated profiles, temporary local servers, synthetic credentials and injected native confirmation replies; it does not demonstrate human interaction with OS dialogs or installed-package behavior. Positive native Keychain/DPAPI/secure-keyring migration across renamed packages remains unverified. The runtime name, userData path, application ID, protocol and configuration identifiers remain unchanged; display names and public asset names change.

Two-way reconciliation has no persistent baseline or deletion propagation. Two-way/mirror/FTP jobs do not have durable resume. FTP folder operations and remote editing are unavailable. SCP recovery requires SFTP support. Folder/mirror operations are a sequence of changes, not an atomic transaction; completed changes remain after interruption. Path-based SFTP/FTP cannot exclude all concurrent external changes, and unknown acknowledgements require inspection. See [workflow limits](SECURE-CONNECTIONS.md) and [branding/storage compatibility](BRANDING.md).

macOS builds remain ad-hoc signed without notarization; Windows builds remain unsigned. Full SecureCRT/SecureFX parity has not been established.
