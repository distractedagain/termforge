# TermForge 0.13.0 verification

Status: implementation and local checks passed. Platform CI and release checks are pending. The verified public download remains v0.12.0 until the final source passes platform CI, packaging and public-asset verification.

## Scope

Reviewed CSV/TSV session import, atomic saved-session updates and SFTP mkdir/rename/delete/chmod operations. See [session import](SESSION-IMPORT.md) and [file transfers](SECURE-CONNECTIONS.md) for behavior and limits.

## Checks

| Local check | Result |
| --- | --- |
| Combined backend suite | 383 passed, zero failures/skips, bounded local concurrency |
| Main interface | 108 passed |
| Credential/transfer interface | 21 passed |
| Shared menus | 24 passed |
| Import wizard | 24 passed, including eight full-application light/dark desktop/compact checks |
| Remote file actions | 17 passed, including narrow light/dark review screens |
| Renderer build | Passed |
| Four-platform source CI, packaging and native Linux IPC | Pending |
| Source tag, publisher and public-asset verification | Pending |

The store checks preserve snapshot identifiers and unrelated settings and reject stale or invalid plans without writing. Import checks cover quoted rows, field validation, secret-field filtering, collision policies, explicit exclusions, file/row limits, expired/single-use plans, shutdown and async races. Remote-operation checks exercise all four operations, symlink/root rejection, target and parent metadata changes, active-transfer exclusion, cancellation, special permission bits and unknown outcomes after lost acknowledgements. They include actual SSH/SFTP wire fixtures alongside injected failure cases.

The initial combined local backend run passed 377 of 378 cases. One existing local-AI 100 ms metadata timeout check expired before its fixture server received a request during parallel load; all 19 local-AI checks passed on an isolated rerun. Its production implementation and assertions were unchanged. The final combined suite uses bounded concurrency locally; platform workflows retain their normal test command.

Headless Chromium uses synthetic application bridges and temporary import files. It checks renderer interactions and geometry, not installed applications. The native Linux smoke adds real preload import-to-store checks and SFTP mutations with fixture picker/approval responses. These native checks have not yet run at the final source.

## Verification limits

No Electron window is launched on the development laptop. Native macOS menu/accessibility behavior, interactive installed packages, physical serial devices, external-server interoperability and successful native credential-store save/unlock remain unverified. Injected native-dialog responses do not test human interaction with the operating system picker or confirmation dialog.

SFTP metadata rechecks do not eliminate remote path races or provide a stable inode identity. Rename depends on a server honoring the standard no-overwrite semantics. Permission handling depends on server support. These tests use synthetic hosts and files, not user data.

macOS builds remain ad-hoc signed without notarization; Windows builds remain unsigned. Complete SecureCRT/SecureFX compatibility is not claimed.
