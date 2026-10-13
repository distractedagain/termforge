# TermForge v0.15.0 — public preview

This update adds four original SFTP workflows inside TermForge:

- **Resumable individual files:** pause between acknowledged chunks, retain private checkpoints across restart, verify source/partial contents and authenticated server/account before a reviewed resume. Explicit verified discard retains uncertain server files for inspection.
- **Folder merging:** review copy, replace, skip and create decisions; skip existing files by default. Changed trees invalidate the review.
- **One-way synchronization:** compare file contents with SHA-256 and review missing/different/equal files in either direction. Destination-only entries remain.
- **Remote text editing:** edit UTF-8 files up to 1 MiB, compare opened/proposed text, confirm save natively and refuse changed remote revisions. Declines, conflicts and disconnects retain the open draft.

These features share the existing host-key verification, credential system and staged transfer engine. No SecureFX executable, source or artwork is included or required.

## Limits

This is another step toward parity, not full SecureFX compatibility. SCP and folder jobs do not resume; recovery does not reconnect automatically. No destructive mirroring, two-way conflict resolver, saved sync jobs, timestamp/ownership replication, FTP/FTPS, drag/drop or external editor integration. Folder updates are not atomic: completed changes remain if a later item fails. Remote drafts live only in memory. New files use 0600 and directories 0700; reviewed folder replacements and remote edits retain ordinary destination file permissions. SFTP v3 cannot eliminate remote path races. Downloads require a local filesystem supporting hard links.

See the source-tagged [workflow guide](https://github.com/distractedagain/termforge/blob/v0.15.0/docs/SECURE-CONNECTIONS.md) and [verification record](https://github.com/distractedagain/termforge/blob/main/docs/VERIFICATION-v0.15.0.md) for test evidence and limits. Test fixtures use temporary loopback servers and synthetic native-dialog responses; installed packages and external-server interoperability are not fully exercised.

## Installation

macOS Apple Silicon and Intel packages are ad-hoc signed and **not notarized**. Windows x64 packages are **unsigned**. Linux x64 packages are provided as AppImage and Debian packages. This preview does not include automatic updates. Only override operating-system download warnings after verifying the intended release and its checksums.

Eight installers/archives, four platform build records and `SHA256SUMS.txt` are published after all four packaging jobs pass and artifact provenance is validated. These checks establish source/build provenance, not complete installed-app interoperability.
