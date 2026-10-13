# ForgeCRT v0.17.0 — public preview

This release adds FTP/FTPS folder transfers and durable recovery, plus saved two-way SFTP synchronization pairs. ForgeCRT remains free, open source and independent of VanDyke Software.

## File transfers

- **FTP/FTPS folders:** inspect nested uploads/downloads, including empty folders, before applying a new-folder copy or a merge with explicit Skip/Replace policy. Reviews show exact paths, counts and bytes, then require native confirmation.
- **FTP/FTPS resume:** eligible files and folders retain private checkpoints after pause, disconnection or restart. Reconnect explicitly and approve recovery. The source, destination, completed files and actual partial contents are verified before continuing. Downloads use REST; uploads append only after verifying the retained prefix. Unsupported server behavior fails without silently restarting the transfer.
- **Identity checks:** recovery binds the protocol, hostname, port and account; FTPS also binds the validated server certificate. Plain FTP remains unencrypted and cannot authenticate server identity cryptographically. No passwords are stored in checkpoints. A second app launch focuses the existing instance so two desktop processes cannot compete over its checkpoints.
- **Retained output:** forgetting an FTP checkpoint preserves completed files, staging files and replacement backups. Unknown commit outcomes disable resume and require inspection.

## Saved two-way synchronization

Choose **Two-way**, keep **Remember changes between runs** enabled, and name the current local/remote folder pair. The first run asks for explicit choices wherever both sides differ. A successful, fully verified run saves a private content baseline.

Later reviews infer additions, edits and deletions relative to that baseline. A change on one side is planned for the other; concurrent differing edits and deletion-versus-edit conflicts require an explicit local/remote/skip choice. Exact permanent deletions appear in both the review and native confirmation. Skipped conflicts retain their previous common ancestor, so they remain conflicts on the next run. File/directory type changes require manual reconciliation.

Saved pairs can reload their folders after reconnecting to the same authenticated SSH server/account. Forgetting a baseline requires confirmation and preserves both trees. Revisions and an exclusive storage lease reject stale or concurrent updates. Transfer failures, cancellations and partial copies before the verified baseline commit preserve the old baseline. An error or crash during the final storage flush or lease release can occur after the new revision was saved; inspect the saved history in that case.

## Limits

Full SecureFX parity remains a goal. Saved synchronization is SFTP-only and runs on explicit review; it is not background monitoring or scheduling. Two-way and mirror jobs still cannot resume. FTP/FTPS synchronization, remote editing, file-management actions, custom-CA UI, whole-queue persistence, automatic reconnect, filters and metadata/ACL/timestamp replication remain unavailable.

Folder workflows are bounded to 2,000 entries per tree, 32 levels and 1 TiB. They reject symlinks, special files and unsafe or colliding names. Copies and deletions commit individually, so completed changes remain after interruption; there is no rollback or trash. Path-based protocols cannot atomically exclude every concurrent writer. A process crash while holding the synchronization storage lease can leave `pairs.lock`; inspect both trees and the stopped process before removing that stale lock. Saved pairs are limited to 100 and 16 MiB total.

FTP recovery needs server support for offset downloads and append uploads. Certificate rotation or an account/endpoint change blocks reuse of its checkpoint. FTP verification reads file contents and can add network traffic. Local downloads require a filesystem with hard-link support. Broader independent-server interoperability remains to be verified.

## Installation and verification

macOS Apple Silicon/Intel packages are ad-hoc signed and **not notarized**. Windows x64 packages remain **unsigned**. Linux x64 packages are provided as AppImage and Debian packages. Internal storage identifiers remain compatible with TermForge; see [storage compatibility](https://github.com/distractedagain/termforge/blob/v0.17.0/docs/BRANDING.md).

See the [workflow guide](https://github.com/distractedagain/termforge/blob/v0.17.0/docs/SECURE-CONNECTIONS.md) and [verification record](https://github.com/distractedagain/termforge/blob/main/docs/VERIFICATION-v0.17.0.md) for completed checks, provenance and remaining installed-app limits. Automated native tests use isolated loopback servers and injected confirmation replies; they do not establish complete external-server or installed-package coverage.
