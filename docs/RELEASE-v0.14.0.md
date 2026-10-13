TermForge 0.14.0 adds reviewed SFTP folder uploads and downloads to its built-in file workspace. It remains free, open source and MIT-licensed; SecureFX is not required or included.

## Copy folder trees

Select one folder in either pane while using SFTP, then choose **Upload** or **Download**. Review the server, exact source and destination, file/folder counts, bytes and included paths. A native confirmation precedes the copy. The queue reports aggregate progress and supports cancellation.

Nested folders, empty folders and zero-byte files are included. The destination must be a new folder: this release does not merge or overwrite existing folder trees. Plans expire after five minutes and cannot be reused. Source metadata and destination ancestry are checked again after approval and before copying children.

## Limits and failure behavior

A review supports at most 2,000 entries including its root, 32 nested levels, and 1 TiB total. Symbolic links, special files, unsafe names and case/Unicode name collisions are refused. SCP continues to support individual files only.

Folder copies commit each child separately. Completed files and created folders remain after cancellation or failure; no recursive cleanup, rollback, automatic retry or resume is performed. A lost remote acknowledgement reports an uncertain outcome that requires inspection before retrying. Remote path races cannot be eliminated by SFTP v3 metadata checks. Local downloads require a filesystem supporting hard links. Permissions and timestamps are not preserved.

See the [file-transfer guide](https://github.com/distractedagain/termforge/blob/main/docs/SECURE-CONNECTIONS.md) and [verification record](https://github.com/distractedagain/termforge/blob/main/docs/VERIFICATION-v0.14.0.md).

## Parity and distribution

This is a functional step toward SecureFX-like workflows. Synchronization, merge/conflict policies, resumable transfers, remote editing and FTP/FTPS remain unavailable. Complete product parity is not claimed.

macOS packages use ad-hoc signing without Apple notarization; Windows packages remain unsigned.
