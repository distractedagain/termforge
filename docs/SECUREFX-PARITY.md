# SecureFX workflow parity

TermForge aims to provide a built-in file-transfer workspace sharing its session profiles and credential manager. SecureFX is not embedded or required. This is a feature and acceptance map, not a claim that matching menus establishes matching behavior.

Baseline: SecureFX 9.7 macOS, with applicable Windows/Linux features tracked separately. Official references were checked on October 13, 2026. The [SecureFX feature catalog](https://www.vandyke.com/products/securefx/features.html) covers protocol, recovery, editor, authentication and automation features; the [synchronization reference](https://www.vandyke.com/products/securefx/file_synchronization.html) describes comparison and mirroring workflows. Platform-specific differences remain part of the target.

## Coverage and acceptance

| Family | TermForge 0.15 scope | Remaining work and completion evidence |
| --- | --- | --- |
| Protocols | SFTP and individual-file SCP; SCP also requires SFTP for browsing/staging | FTP/FTPS, HTTP(S), WebDAV and S3; verify protocol-specific authentication, certificate validation, filenames and errors against independent servers |
| Folder copying | Reviewed nested SFTP copy/merge, skip/replace policy, empty folders and aggregate progress | Additional conflict policies, age-based replacement, filtering, configurable permissions, timestamp preservation, text conversion and deliberate link handling; test conflicting trees without silent data loss |
| Queue and recovery | Serial jobs; durable individual SFTP checkpoints, reviewed pause/resume and verified discard | Whole-queue/folder/SCP recovery, automatic reconnect, bandwidth and concurrency settings; interrupt network/app mid-file and verify source identity, destination identity and final bytes after recovery |
| Synchronization | One-way SHA-256 content synchronization, copy/replace/skip review; destination-only entries retained | Mirroring, two-way conflict rules, additional comparison categories, filters, saved configurations and server-to-server workflows; preview additions/replacements/deletions, revalidate before apply, and independently verify the resulting trees |
| File workspace | Two-pane browser, file/folder copy, mkdir, rename, delete, chmod and bounded UTF-8 remote text editing | External editor integration, synchronized browsing, bookmarks, filters, transfer tabs and platform-appropriate drag/drop; test editor save conflicts, focus, keyboard operation and accessibility |
| Authentication and connectivity | Managed host-key pins, named credentials, key/agent/password/interactive authentication | Certificate/smart-card/GSSAPI options, named proxies and dependent/jump sessions for file transfer; verify against actual supported servers. Terminal and file transfer currently authenticate separately |
| Automation and integration | Shared TermForge profiles and built-in file UI | Dedicated unattended transfer/sync CLI and transfer scripting, explicit credential/error/exit-code behavior, and scheduling integrations. SecureFX's SFXCL is Windows/Linux and its built-in scheduler is Windows-only |

## Continuing implementation order

1. Extend individual SFTP recovery to bounded folder jobs and whole-queue persistence, then add reconnection policies.
2. Extend reviewed merge policies with explicit rename, filtering, metadata and age-based rules.
3. Extend one-way content synchronization; destructive mirroring requires explicit deletion review and separate tests.
4. Extend the bounded remote editor with richer editing, external-editor integration and durable draft handling.
5. Additional protocols and enterprise connection options: each needs its own trust model and interoperability matrix.
6. Automation, platform integration and complete parity regression suites.

This order is an engineering recommendation based on TermForge's current architecture. It is not inferred from SecureFX's internal implementation. Each family needs ordinary success cases, failure/recovery cases and real native behavior before it can be marked complete.

## Evidence boundaries

Version 0.15's [verification record](VERIFICATION-v0.15.0.md) distinguishes local tests, headless UI, native Linux IPC, platform builds and installed-app behavior. See [file-transfer limits](SECURE-CONNECTIONS.md) and the broader [feature inventory](FEATURES.md).

Focused static analysis of user-supplied SecureFX artifacts can help identify observable workflows, but it does not establish runtime behavior, complete implementation coverage or compatibility. Reference binaries, raw decompilation and proprietary artwork are kept outside the TermForge repository. Feature implementations and tests are original.
