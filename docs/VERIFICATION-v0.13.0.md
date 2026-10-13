# TermForge 0.13.0 verification

Status: all four platform CI jobs and all four package builds passed at source `fe4b4359d418db7dab09fd9a1e49c62f0717272d`. Publication and public-asset checks are pending; the verified public download remains v0.12.0 until those checks finish.

## Scope

Reviewed CSV/TSV session import, atomic saved-session updates and SFTP mkdir/rename/delete/chmod operations. See [session import](SESSION-IMPORT.md) and [file transfers](SECURE-CONNECTIONS.md) for behavior and limits.

## Checks

| Local check | Result |
| --- | --- |
| Combined backend suite | 383 passed, zero failures/skips, bounded local concurrency |
| Main interface | 108 passed |
| Credential/transfer interface | 21 passed |
| Shared menus | 24 passed |
| Import wizard | 25 passed, including eight full-application light/dark desktop/compact checks |
| Remote file actions | 17 passed, including narrow light/dark review screens |
| Renderer build | Passed |
| Four-platform source CI, packaging and native Linux IPC | Passed at the source above |
| Source tag, publisher and public-asset verification | Pending |

The store checks preserve snapshot identifiers and unrelated settings and reject stale or invalid plans without writing. Import checks cover quoted rows, field validation, secret-field filtering, collision policies, explicit exclusions, file/row limits, expired/single-use plans, shutdown and async races. Remote-operation checks exercise all four operations, symlink/root rejection, target and parent metadata changes, active-transfer exclusion, cancellation, special permission bits and unknown outcomes after lost acknowledgements. They include actual SSH/SFTP wire fixtures alongside injected failure cases.

The initial combined local backend run passed 377 of 378 cases. One existing local-AI 100 ms metadata timeout check expired before its fixture server received a request during parallel load; all 19 local-AI checks passed on an isolated rerun. Its production implementation and assertions were unchanged. The final combined suite uses bounded concurrency locally; platform workflows retain their normal test command.

The first Linux CI candidate exposed a queued dialog-close event that could discard a newly selected import after rapid reopening. A deterministic regression reproduced the bug with the old handler and passed after cleanup was limited to a still-closed dialog. Import UI waits also track completion of the corresponding bridge request. The corrected source passed a fresh complete platform run.

## Platform evidence

All jobs in [source CI](https://github.com/distractedagain/termforge/actions/runs/38440766909) and [installer packaging](https://github.com/distractedagain/termforge/actions/runs/38440765762) passed at the exact source above.

- Both Macs and Linux each passed 383 backend tests, with no skips or failures. Windows passed 375 with eight expected platform-specific skips.
- Linux passed 240 interface checks: 108 workspace, 13 project, 21 credentials/transfers, 23 Quick Connect, 24 menus, nine key tools, 25 imports and 17 remote file actions.
- Both Macs and Linux each passed seven real localhost Ansible checks.
- Production dependency audits reported zero vulnerabilities. Both Mac packages passed strict recursive ad-hoc signature integrity checks.
- The real Linux Electron smoke passed its existing SSH/PTY, menu, clipboard, editor-worker and Quick Connect checks, plus the new import and remote file operations.

Headless Chromium uses synthetic application bridges and temporary import files. It checks renderer interactions and geometry, not installed applications. The Linux Electron smoke exercised import through the actual preload, native menu and atomic store, confirming one-use review tokens, source preservation and no automatic connection. Actual loopback SSH/SFTP operations created a directory, renamed a file, changed permissions, deleted the empty directory and restored the filename; contents and mode were checked independently on disk. Picker and approval responses were fixtures. Its OS credential provider was insecure `basic_text`, so it verified refusal to save credentials rather than successful secure-vault storage.

## Verification limits

No Electron window is launched on the development laptop. Native macOS menu/accessibility behavior, interactive installed packages, physical serial devices, external-server interoperability and successful native credential-store save/unlock remain unverified. Injected native-dialog responses do not test human interaction with the operating system picker or confirmation dialog.

SFTP metadata rechecks do not eliminate remote path races or provide a stable inode identity. Rename depends on a server honoring the standard no-overwrite semantics. Permission handling depends on server support. These tests use synthetic hosts and files, not user data.

macOS builds remain ad-hoc signed without notarization; Windows builds remain unsigned. Complete SecureCRT/SecureFX compatibility is not claimed.
