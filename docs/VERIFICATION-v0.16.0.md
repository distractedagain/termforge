# ForgeCRT 0.16.0 verification

Status: [ForgeCRT v0.16.0 is published](https://github.com/distractedagain/termforge/releases/tag/v0.16.0). Local validation, all four platform CI jobs, installer packaging, native Linux smoke and independent public-asset verification passed.

## Scope

ForgeCRT display-name transition; durable SFTP folder copy/merge/one-way synchronization recovery; actual initial SCP payload with verified SFTP recovery; explicit two-way conflict reconciliation; reviewed mirroring with target-only deletion; passive FTP and explicit/implicit FTPS file browsing and transfers.

## Local evidence

- Complete backend suite: 546 passed, zero failures/skips, bounded concurrency. A subsequent real-SFTP mirror regression also passed with 22 targeted mirror/two-way checks, bringing the final source suite to 547 tests.
- Final protocol coverage includes 51 recovery tests, 61 folder tests and 25 FTP/FTPS tests. These use isolated temporary files and real loopback SSH/SFTP/FTP/TLS sockets where specified; SCP initial payload and resumed suffix are checked separately in both directions.
- All 300 headless interface checks passed: 242 across the eight existing main/project/security/Quick Connect/menu/key/import/remote-operation suites plus the 58 transfer checks below.
- Transfer UI suites passed 19 folder, 23 existing workflow and 16 new advanced workflow checks in headless Chromium. The advanced suite covers protocol capability gating, explicit conflict review, exact mirror deletions, folder/SCP recovery labels, early completion, queued FTP refresh, late connection-close events and narrow-window focus/layout.
- Renderer builds, syntax checks and diff validation passed. Production dependency audit found zero vulnerabilities.
- Independent reviews fixed disconnected FTP cleanup ownership, source/target validation order before mirror deletion, premature queue refresh, one-sided refresh after fast two-way completion and stale connection state after a close event raced the open reply.
- Wide dark conflict-review and narrow FTP-form screenshots were visually inspected. No Electron process was launched on the development laptop.

## Platform issues corrected before publication

Initial CI passed 547 backend tests on both Macs and Linux, plus all 300 Linux interface checks and seven localhost Ansible checks. Windows exposed large numeric filesystem identifiers in recovery metadata and a transient SCP staging-file lock; focused regression fixes passed 51 local recovery tests, including an opaque filesystem-ID fixture and transient/persistent lock cases. The final bounded SCP reopen checks also passed 3/3. The initial packaging hook referenced a nonexistent optional notice; it now packages the dependency’s actual LICENSE.txt, and the complete license-copy hook passes locally. The expanded native smoke reached successful folder recovery before its old two-minute suite timeout; its overall budget is now five minutes, with individual operation deadlines unchanged. No initial-run artifacts were published.

The corrected source passed all 550 backend tests on both Macs and 532 with 18 expected platform skips on Windows. Apple Silicon, Windows and Linux packaging passed, but the Intel packaging runner exposed two lost-response tests whose injected 50 ms deadline could expire during successful setup. Those fixtures now allow a bounded two-second RPC deadline, deliberately delay ordinary reads beyond the old threshold, and assert that the intended missing OPEN/RENAME response was actually reached. Their nine-test wire suite passed locally; production timeouts remain unchanged. Final builds and CI must include this fixture correction.

## Final platform evidence

The release tag points to tested source `cab6f7edc9d6cddf20381f822b2dc3da95f17026`. All four [source CI jobs](https://github.com/distractedagain/termforge/actions/runs/38479293855) and [installer builds](https://github.com/distractedagain/termforge/actions/runs/38479293220) passed at that exact commit.

| Platform | Backend tests passed | Expected skips | Failures |
| --- | ---: | ---: | ---: |
| macOS Apple Silicon | 550 | 0 | 0 |
| macOS Intel | 550 | 0 | 0 |
| Linux x64 | 550 | 0 | 0 |
| Windows x64 | 532 | 18 | 0 |

Linux passed all 300 headless interface checks and seven localhost Ansible checks. Both Macs also passed the seven localhost Ansible checks. Production audits reported zero vulnerabilities. Both macOS application bundles passed strict ad-hoc signature integrity verification; this is not Apple notarization.

The final native Linux Electron run passed folder recovery, two-way conflict choices, mirror decline/apply, FTP/explicit FTPS/implicit FTPS round trips, control/data certificate rejection, and masked FTP authentication through the real preload boundary. Existing SSH host verification, SFTP file/remote-edit workflows, native Quick Connect, menu routing, PTY, editor and import checks also passed. The runtime name, native userData path, Chromium session-data path, isolated configuration override and ForgeCRT display branding were verified. Linux's insecure `basic_text` credential backend was correctly refused; a successful OS keyring unlock was not exercised.

## Publication

The [publisher](https://github.com/distractedagain/termforge/actions/runs/38480241621) passed after validating the eight packages and four platform build records. Public release ID `412173744` is a published preview. Anonymous verification completed at `2026-10-13T22:50:04.934Z`: the exact source tag, all thirteen public assets and twelve manifest entries matched. The checksum manifest and four build records were downloaded anonymously and independently hashed. Eight installer hashes were compared against GitHub's recorded SHA-256 asset digests; installer bytes were not downloaded or independently rehashed again during that separate public check.

## Evidence boundaries

Headless UI uses a synthetic bridge. Native smoke uses isolated profiles, temporary local servers, synthetic credentials and injected native confirmation replies; it does not demonstrate human interaction with OS dialogs or installed-package behavior. Positive native Keychain/DPAPI/secure-keyring migration across renamed packages remains unverified. The runtime name, userData path, application ID, protocol and configuration identifiers remain unchanged; display names and public asset names change.

Two-way reconciliation has no persistent baseline or deletion propagation. Two-way/mirror/FTP jobs do not have durable resume. FTP folder operations and remote editing are unavailable. SCP recovery requires SFTP support. Folder/mirror operations are a sequence of changes, not an atomic transaction; completed changes remain after interruption. Path-based SFTP/FTP cannot exclude all concurrent external changes, and unknown acknowledgements require inspection. See [workflow limits](SECURE-CONNECTIONS.md) and [branding/storage compatibility](BRANDING.md).

macOS builds remain ad-hoc signed without notarization; Windows builds remain unsigned. Full SecureCRT/SecureFX parity has not been established.
