# ForgeCRT v0.16.0 — public preview

TermForge is now **ForgeCRT**. The original terminal and file-transfer workspace keeps the same repository, application identifier and established storage location. Existing profiles, trusted hosts, credentials and transfer checkpoints do not require an export/import migration. Internal `termforge` identifiers intentionally remain. ForgeCRT is independent of VanDyke Software and contains no SecureCRT/SecureFX executable, source or artwork.

## File workflows

- **Resumable folders:** eligible SFTP copy, merge and one-way synchronization jobs retain their reviewed inventory, completed-file fingerprints and current child offset across restart. Explicit resume verifies the source, completed target files and authenticated endpoint. Forgetting a folder checkpoint preserves all completed outputs and staging files.
- **Hybrid SCP recovery:** initial payloads use actual legacy SCP. Reviewed resume verifies the retained prefix and sends the remaining bytes over SFTP, because legacy SCP has no portable offset-resume operation. Server SFTP support remains required.
- **Two-way synchronization:** missing files/folders copy in both directions, equal content is skipped, and differing common files require a per-path local/remote/skip choice. No implicit newest-time winner or deletion propagation.
- **Reviewed mirroring:** one-way source/destination review includes exact target-only file and directory deletions. A separate native confirmation warns of permanent deletion. Files are revalidated and directories are removed only when empty, in child-first order.
- **FTP and FTPS:** separate passive FTP, explicit FTPS and implicit FTPS connections support browsing and queued individual-file upload/download. Plain FTP requires native consent before connecting. FTPS verifies trusted certificates and hostnames on control and data sockets, with TLS 1.2 minimum and no insecure fallback. Passwords are transient.

## Limits

Full SecureFX parity remains a development goal. Folder/SCP recovery does not reconnect automatically. Two-way and Mirror jobs, FTP/FTPS jobs and full queues do not have durable resume. Two-way synchronization has no persistent baseline or deletion propagation. FTP/FTPS does not yet support folders, synchronization, remote editing, file-management actions or a custom-CA form. Saved sync configurations, filtering, metadata/ACL/timestamp replication, drag/drop and external-editor integration remain future work.

Folder operations are not atomic. Completed files, created directories and acknowledged mirror deletions remain when later work fails or is cancelled. Mirroring does not use a trash folder. Source/destination changes invalidate plans, but neither SFTP nor FTP can exclude every external path race atomically. Unknown mutation outcomes stop the connection and require inspection. FTP replacements retain previous-file backups, and failed/cancelled FTP transfers retain staging paths. SFTP downloads still require local hard-link support.

The earlier bounded UTF-8 remote editor remains SFTP-only. Drafts live in memory. New SFTP files use mode 0600 and directories 0700; reviewed SFTP replacements retain ordinary destination file permissions. These content/path workflows do not promise ownership or timestamp replication.

## Installation and verification

macOS Apple Silicon and Intel packages are ad-hoc signed and **not notarized**. Windows x64 packages are **unsigned**. Linux x64 packages are provided as AppImage and Debian packages. This preview does not include automatic updates. Verify the intended release and checksums before overriding operating-system download warnings.

The display name changes to ForgeCRT, while the internal runtime name remains TermForge to preserve OS credential-store lookup. Packaged Keychain/DPAPI/keyring migration has not been interactively verified on every platform; a renamed ad-hoc macOS bundle may need renewed Keychain access. If a stored credential cannot unlock, the vault reports an error and does not replace it with plaintext or silently reset it. See [branding and storage compatibility](https://github.com/distractedagain/termforge/blob/v0.16.0/docs/BRANDING.md).

Eight installers/archives, four platform build records and `SHA256SUMS.txt` are published only after all platform packaging jobs pass and provenance validates. Tests use temporary loopback servers and synthetic dialog responses; those checks do not establish complete installed-app or independent-server interoperability. See the [workflow guide](https://github.com/distractedagain/termforge/blob/v0.16.0/docs/SECURE-CONNECTIONS.md) and [verification record](https://github.com/distractedagain/termforge/blob/main/docs/VERIFICATION-v0.16.0.md) for the actual completed checks and remaining boundaries.
