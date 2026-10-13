TermForge 0.12.0 brings a shared desktop menu system organized like the SecureCRT macOS reference: **File, Edit, View, Options, Transfer, Script, Tools, Window and Help**. Native and in-app menus now share command availability, checked state, recent items and nested submenus. TermForge remains free, open source and MIT-licensed.

## Menu workflows

- Connect, Quick Connect, local shell, snapshots, reconnect/disconnect all, recent sessions and active-tab selection are easier to reach.
- Clipboard commands respect focused text fields and the project editor. Terminal actions include copy-and-paste, quotation paste, separate screen/scrollback clearing, focus shortcuts and font zoom.
- View controls expose the toolbar, status bar, docked managers, terminal scrollbar and supported window opacity.
- Script menus include start/stop/cancel recording and reviewed recent-script execution.
- Help links lead to TermForge's project, releases and issue tracker. Features without implementations are clearly unavailable.

## New terminal and key tools

- Plain-text logging, separate ASCII receive capture, byte logging and Hex View on supported transports. Hex View retains the latest 64 KiB; output files stop at 128 MiB.
- Reviewed binary sends of up to 256 KiB on managed SSH, raw TCP and compatible serial settings. SFTP/SCP remains available for named file transfers.
- Terminal screen, scrollback and selection printing with text preview and page settings, followed by the system print dialog.
- Encrypted Ed25519/RSA-3072 key-pair creation and compatible OpenSSH/PEM private-key conversion to a new OpenSSH file. Existing files are never overwritten and conversion preserves its source.
- A read-only viewer for public fingerprints in the system OpenSSH agent. Key passphrases use private subprocess input rather than command arguments or configuration storage.

## Scope and installation

The [menu guide](https://github.com/distractedagain/termforge/blob/main/docs/MENUS.md) explains command behavior and limits. This is partial feature coverage, not complete SecureCRT equivalence. Kermit/Xmodem/Ymodem/Zmodem, live-tab detachment, cascading windows, session locking, configuration master passwords, full XML/text settings imports and remote public-key installation remain unavailable.

OpenSSH client tools are required for the key utilities. Managed SSH, TCP and serial offer byte features that local/system-OpenSSH PTYs do not expose. Printing still needs manual real-printer and Save as PDF verification on each platform. Automated tests do not establish physical serial-device interoperability or native macOS visual parity.

macOS packages use ad-hoc signing without Apple notarization; Windows packages are unsigned. See the [0.12 verification record](https://github.com/distractedagain/termforge/blob/main/docs/VERIFICATION-v0.12.0.md) for the tested source, platform checks, release-integrity evidence and remaining verification limits.
