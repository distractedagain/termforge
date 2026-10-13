# Desktop menus

TermForge 0.12 follows the familiar **File, Edit, View, Options, Transfer, Script, Tools, Window, Help** order from the SecureCRT macOS interface. A shared command model drives the native desktop menu and the in-app menus, including checked state, contextual availability, recent items, submenus and shortcuts. This is an independent implementation, not complete SecureCRT compatibility.

An action can be disabled because no suitable terminal, selection or operation is active. Features that have no implementation are labeled unavailable; the in-app menu also provides a reason on hover. **Help → Feature Availability** explains the remaining gaps. TermForge has no commercial purchase, registration or license-key menu.

## Menu map

| Menu | Available actions | Scope and remaining gaps |
| --- | --- | --- |
| File | Saved-session connect, Quick Connect, connect in a tab/tile, local shell, open/save/manage snapshots, reconnect/disconnect one or all sessions, clone, SFTP, print, logging, recent sessions, new/close tab, project open/save | Snapshot restoration reviews saved profiles before connecting. Recent sessions refer to saved profiles. Session locking and protocol tracing are unavailable. |
| Edit | Copy, paste, copy-and-paste, paste as quotation, select all, find, print selection, focus command/terminal/manager panes, clear scrollback/screen/both, break, reset, undo/redo/cut in editable fields | Multiline terminal paste retains its review setting. Quotation prefixes each line with `> `; it is a formatting action, not shell escaping. Break requires serial or Telnet. Native operating-system dictation/AutoFill are not implemented as TermForge commands. |
| View | Toolbar, command window, status bar, button bar, three managers, Hex View, terminal font zoom, window opacity, vertical terminal scrollbar, full screen, Connect Bar, project workspace, AI assistant | Hex View needs a byte-capable transport. Opacity is available on macOS/Windows. Horizontal scrolling is unavailable; terminals fit and reflow to their pane. |
| Options | Session/global options, Button Bar/keymap/color configuration, keyword highlighting toggle/properties, save settings now | Keymap Editor opens the selected session's keyboard options. Preferences save when their dialog is applied. Deferred global saving and a global firewall toggle are unavailable; SSH jump settings remain per session. |
| Transfer | Send ASCII, receive/stop ASCII capture, send binary on supported transports, TFTP server, SFTP/SCP browser | ASCII and binary sending write to a session and can execute commands. Kermit, Xmodem, Ymodem and Zmodem are unavailable. SFTP/SCP retains its existing file-browser and transfer limits. |
| Script | Run/cancel Python script, start/stop/cancel input recording, recent scripts, script output | Recorded input must be reviewed before export. Recent scripts remain in memory for this application run and require native confirmation before rerunning. Scripts execute with the user's local privileges. SecureCRT scripting compatibility remains partial. |
| Tools | Keymap Editor, create key pair, convert compatible private key to OpenSSH, view agent fingerprints, saved credentials, export/import TermForge settings, import SecureCRT session INI files, trusted-host management, clear command history | Agent key addition/removal, remote public-key installation, configuration/master passwords, full SecureCRT XML imports and text session-list imports are unavailable. |
| Window | Tabs, vertical/horizontal/grid tiling, single/new tab groups, move to next group, minimize/zoom, next/previous tab, bring windows forward, active-tab list, close window | Cascade and detaching live tabs into independent windows are unavailable. |
| Help | Help topics, project page, release page, issue tracker, availability guide, version/about | Updates opens the GitHub releases page; there is no automatic installer or update service. |

## Shortcuts and focus

On macOS, **Command+E** opens the saved-session connection workflow, **Command+K** opens Quick Connect, **Command+T** opens Quick Connect for a tab, and **Command+L** opens a local shell. Windows/Linux use Control for these shortcuts. Terminal copy/paste use Command+C/V on macOS and Control+Shift+C/V elsewhere.

Menus preserve normal editing in text fields and the project editor. Quick Connect has an isolated bridge: menu editing is directed to its fields while workspace commands are blocked behind it. In-app menu submenus support keyboard navigation and Escape. Mapped session keys retain priority while their terminal owns focus.

## Terminal data and printing

**Log Session** writes a plain-text received-output transcript with terminal escape sequences removed. **Raw Log Session** retains the received data bytes. **Receive ASCII** writes a separate plain-text capture from the time it starts until it is stopped or the connection closes. Files are new-only and limited to 128 MiB; existing files and symbolic-link destinations are never replaced. Pause Logging applies to the session log, not a separate ASCII capture. These tools do not redact credentials or other sensitive received output.

Raw logging and Hex View support managed SSH, raw TCP, Telnet and serial. For Telnet, the byte view is the terminal payload after Telnet negotiation processing, not a network packet trace. Managed SSH combines bytes received on the terminal's output streams. System OpenSSH and local PTYs expose decoded text and therefore do not offer raw logging or Hex View. Hex View retains at most the latest 64 KiB and refreshes on request.

**Send Binary** accepts a regular local file of at most 256 KiB and asks for native confirmation identifying the session. It is available for managed SSH, raw TCP, and serial configured for eight data bits without software flow control. The receiver must be ready for the bytes; this action does not create a named remote file or provide a transfer protocol. Use the SFTP/SCP browser for named file transfers.

**Print Screen**, **Print Scrollback** and **Print Selection** preview terminal text before opening the operating system print dialog. Page Setup stores paper size (Letter, A4 or Legal) and orientation locally. Printed documents escape terminal content and run in an isolated window with scripting disabled. Real printer and Save as PDF interaction require manual platform verification; automated rendering checks alone do not establish printer compatibility.

## SSH key tools

Install the system OpenSSH client tools to use key generation, conversion and agent listing. **Create Public Key** creates both a private key and its `.pub` file, using Ed25519 or RSA-3072. The default requires a passphrase of at least eight characters. An unencrypted private key requires an explicit checkbox and a separate native warning.

The private-key destination is chosen in a native file picker. Neither it nor its matching public-key file may already exist. OpenSSH receives passphrases through a private input pipe on macOS/Linux or a private ConPTY console on Windows. The Windows console sends each answer only after its expected prompt; its output is discarded. Windows key creation/conversion requires build 18309 or newer; older builds are rejected before launching a key tool. Passphrases never enter command arguments, environment variables or passphrase files. Before saving, TermForge checks that the requested encryption and public-key identity are intact. Passphrases are not retained in configuration or the credential vault.

**Convert Private Key to OpenSSH Format** works on a private temporary copy of a compatible OpenSSH or PEM key, then saves to a new destination. It leaves the original untouched and can set a new passphrase. Unsupported key types and incorrect passphrases fail without writing the chosen destination. It does not convert PuTTY PPK or proprietary SecureCRT private-key formats.

**Manage Agent Keys** shows public SHA-256 fingerprints exposed by the current OpenSSH agent. It distinguishes an unavailable agent from an empty agent. Adding, removing and unlocking identities remain actions in system SSH tools; this viewer never performs them.

Key-format and passphrase behavior follows the installed OpenSSH implementation: see the [official ssh-keygen manual](https://man.openbsd.org/ssh-keygen.1) and [OpenSSH passphrase input implementation](https://github.com/openssh/openssh-portable/blob/master/readpass.c). TermForge uses its own original UI and safety checks around those tools.

## Verification boundaries

The key tools have local macOS tests using real OpenSSH and temporary synthetic key material, plus isolated headless browser checks. Menu model/backend tests and full renderer checks exercise command routing and state without using personal servers or credentials. Cross-platform CI, packaging and release evidence belong in the versioned verification record when complete. Native macOS visual appearance, real printer behavior, physical serial hardware and all third-party OpenSSH distributions require additional manual coverage.
