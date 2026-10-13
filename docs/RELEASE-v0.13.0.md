TermForge 0.13.0 adds a reviewed session-import wizard and remote file management to the SFTP workspace. It remains free, open source and MIT-licensed.

## Import session lists

**Tools → Import Settings from Text File** now imports UTF-8 CSV, TSV, semicolon-separated files and one-column host lists. Map fields, preview row errors, explicitly exclude invalid rows and choose skip, rename or replace for duplicate session names. Replacing a profile keeps its ID so saved workspaces still refer to it.

The final save checks that sessions have not changed since preview, asks for native confirmation and writes atomically. Imports do not open connections, alter the source file, or import password/credential references. See the [import guide](https://github.com/distractedagain/termforge/blob/main/docs/SESSION-IMPORT.md) for limits and replacement behavior.

## Manage remote files

The SFTP workspace gains **New folder**, **Rename**, **Delete** and **Permissions**, plus a permissions column. Each action inspects the target, shows its exact server/path, and requires native confirmation before rechecking metadata and applying the change. Conflicting transfers are blocked while an operation is under review.

New folders use mode 0700. Renames require a missing destination. Delete supports one regular file or empty directory; there is no recursive deletion or trash. Permission changes accept 000–777 and reject targets with setuid, setgid or sticky bits. Symbolic links and special files cannot be changed.

SFTP v3 cannot make the final path check and mutation atomic against other processes. A lost acknowledgement reports an unknown outcome and closes the connection; reconnect and inspect before retrying. See the [file-transfer guide](https://github.com/distractedagain/termforge/blob/main/docs/SECURE-CONNECTIONS.md).

## Coverage

This advances session migration and daily file management; full SecureCRT/SecureFX parity remains incomplete. XML imports, recursive transfers, synchronization, live-tab detachment, session locking and legacy modem-transfer protocols are still unavailable.

macOS packages use ad-hoc signing without Apple notarization; Windows packages are unsigned. The [verification record](https://github.com/distractedagain/termforge/blob/main/docs/VERIFICATION-v0.13.0.md) distinguishes source tests, platform builds, public-asset verification and untested installed-app behavior.
