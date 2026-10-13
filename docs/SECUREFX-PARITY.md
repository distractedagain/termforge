# SecureFX workflow parity

TermForge aims to provide a built-in file-transfer workspace sharing its session profiles and credential manager. SecureFX is not embedded or required. This is a feature and acceptance map, not a claim that matching menus establishes matching behavior.

Baseline: SecureFX 9.7 macOS, with applicable Windows/Linux features tracked separately. Official references were checked on October 13, 2026. The [SecureFX feature catalog](https://www.vandyke.com/products/securefx/features.html) covers protocol, recovery, editor, authentication and automation features; the [synchronization reference](https://www.vandyke.com/products/securefx/file_synchronization.html) describes comparison and mirroring workflows. Platform-specific differences remain part of the target.

## Coverage and acceptance

| Family | TermForge 0.14 scope | Remaining work and completion evidence |
| --- | --- | --- |
| Protocols | SFTP and individual-file SCP; SCP also requires SFTP for browsing/staging | FTP/FTPS, HTTP(S), WebDAV and S3; verify protocol-specific authentication, certificate validation, filenames and errors against independent servers |
| Folder copying | Reviewed nested SFTP copy to a new destination; empty folders, aggregate progress and cancellation | Merge/conflict policies, age-based replacement, filtering, configurable permissions, timestamp preservation, text conversion and deliberate link handling; test conflicting trees without silent data loss |
| Queue and recovery | Serial in-memory jobs; stop/cancel and retained partial output | Persisted queue, pause/resume, reconnect recovery, bandwidth and concurrency settings; interrupt network/app mid-file and verify source identity, destination identity and final bytes after recovery |
| Synchronization | No synchronization engine; folder copy is not synchronization | Upload/download sync, mirroring, source/target comparison categories, filters, saved configurations and server-to-server workflows; preview additions/replacements/deletions, revalidate before apply, and independently verify the resulting trees |
| File workspace | Two-pane browser, file/folder copy, mkdir, rename, regular-file/empty-folder delete, chmod | Remote editing, synchronized browsing, bookmarks, filters, transfer tabs and platform-appropriate drag/drop; test editor save conflicts, focus, keyboard operation and accessibility |
| Authentication and connectivity | Managed host-key pins, named credentials, key/agent/password/interactive authentication | Certificate/smart-card/GSSAPI options, named proxies and dependent/jump sessions for file transfer; verify against actual supported servers. Terminal and file transfer currently authenticate separately |
| Automation and integration | Shared TermForge profiles and built-in file UI | Dedicated unattended transfer/sync CLI and transfer scripting, explicit credential/error/exit-code behavior, and scheduling integrations. SecureFX's SFXCL is Windows/Linux and its built-in scheduler is Windows-only |

## Implementation order

1. Durable transfer queue and reviewed recovery: establish what may be resumed after interruption and prevent resuming into an unrelated or changed file.
2. Merge and conflict planning: preview every replacement, skip and rename, with clear policies and changed-tree detection.
3. Comparison and synchronization: build on that plan format; destructive mirroring requires explicit deletion review and separate tests.
4. Remote editing and workspace refinements: temporary local working copy, external-change detection and reviewed save-back.
5. Additional protocols and enterprise connection options: each needs its own trust model and interoperability matrix.
6. Automation, platform integration and complete parity regression suites.

This order is an engineering recommendation based on TermForge's current architecture. It is not inferred from SecureFX's internal implementation. Each family needs ordinary success cases, failure/recovery cases and real native behavior before it can be marked complete.

## Evidence boundaries

Version 0.14's [verification record](VERIFICATION-v0.14.0.md) distinguishes local tests, headless UI, native Linux IPC, platform builds and installed-app behavior. See [file-transfer limits](SECURE-CONNECTIONS.md) and the broader [feature inventory](FEATURES.md).

Focused static analysis of user-supplied SecureFX artifacts can help identify observable workflows, but it does not establish runtime behavior, complete implementation coverage or compatibility. Reference binaries, raw decompilation and proprietary artwork are kept outside the TermForge repository. Feature implementations and tests are original.
