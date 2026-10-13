# SecureCRT 9.7 feature parity ledger

TermForge's current direction is an **original modern interface**, as selected by the user for 0.7. This supersedes the earlier request to closely reproduce **SecureCRT 9.7 on macOS** visually. The overall project goal remains every applicable SecureCRT feature across **macOS, Windows, and Linux**. This is a development ledger, not a claim of complete feature or script compatibility. Visual identity is now TermForge's own; historical reference comparisons below retain their original evidence boundaries.

Reference checked October 12, 2026. VanDyke's [macOS product page](https://www.vandyke.com/products/securecrt/mac.html) identifies the 9.7 family; its [release history](https://www.vandyke.com/products/history.php?prod=securecrt) currently lists 9.7.3. The [platform feature grid](https://www.vandyke.com/products/securecrt/features.html) supplies platform applicability. Public documentation is incomplete: exact dialog inventories, defaults, shortcuts, and interaction details still need comparison with an authorized running 9.7 macOS installation. No proprietary code or artwork is used.

## How to read the ledger

The baseline columns below describe the **published Harbor v0.2.0 source**, commit `4afedc8f4fa479a45b41372c2790d086c2bf4b49`. Changes being developed after that release are recorded separately at the end. They must not silently change release claims. Current acceptance gates measure functional coverage, usability and platform behavior; references to visual equivalence in versioned history describe the earlier goal.

- **Implemented** means the narrow Harbor workflow exists and has the indicated evidence. It does not certify all SecureCRT variations or visual equivalence.
- **Partial** means a subset exists, or it depends on an external program without full UI/control or integration evidence.
- **Missing** means no app implementation was found in the baseline. Showing a label or saving an unused option does not count as implementation.
- **Not applicable to macOS** means VanDyke marks the capability Windows-only; it remains a requirement on Windows within the overall project goal. Separate-product integration remains a compatibility gap. Commercial license enforcement and purchased support terms do not apply to a free MIT project.

Every acceptance gate is an original TermForge engineering requirement. These are test plans, not results. A row can advance only when its implementation, repeatable test, platform, and remaining limits are recorded. Do not compute a percentage from rows: an entire protocol engine and a small menu action are not equal units of work.

## Existing evidence

| Key | Evidence and boundary |
| --- | --- |
| E1 | `tests/core.test.cjs`: validation, separate launch arguments, forwarding contracts, synthetic platform launch contracts, persistence, import atomicity, and limited INI parsing. A unit test does not prove remote protocol success. |
| E2 | `tests/terminals.test.cjs`: PTY-manager lifecycle, resizing, early output, and new-file output logs using injected processes. |
| E3 | `scripts/smoke.cjs`, `scripts/ssh-smoke.cjs`, and `docs/FEATURES.md`: earlier macOS Intel native smoke evidence for real local PTYs and an isolated loopback SSH server, including changed-host-key refusal. Not an external device test. |
| E4 | `docs/UI-VERIFICATION.md`: 20 v0.2 headless renderer checks with a synthetic bridge; 1280×800 and 850×600, no console errors. No Electron window, actual authentication, or actual transfer in that run. |
| E5 | `app/core.cjs`, `app/terminals.cjs`, `app/main.cjs`, `app/preload.cjs`, and `renderer/src.js`: baseline source inspection. Missing rows were not backed by executable implementations there. |
| E6 | [Native CI](https://github.com/distractedagain/termforge/actions/runs/38313894433) and [package builds](https://github.com/distractedagain/termforge/actions/runs/38313894114): macOS ARM64/Intel, Windows x64, and Linux x64 passed source checks/builds. Packages are not interactive runtime verification; macOS signatures are ad-hoc and unnotarized. |

## macOS appearance and session workspace

Sources: [macOS overview and screenshots](https://www.vandyke.com/products/securecrt/mac.html), [Session Manager pin/auto-hide behavior](https://www.vandyke.com/support/tips/toggle-session-manager-between-pinned-and-auto-hide-states.html), [moving tabs](https://www.vandyke.com/support/tips/dragouttabs.html), [9.7 changes](https://www.vandyke.com/products/securecrt/new-in.html).

| ID | Capability | v0.2 status / evidence | TermForge acceptance gate still required |
| --- | --- | --- | --- |
| UI-01 | macOS window and menus | Partial; E4/E5, native menu plus an in-window menu row | Verify action coverage, native titlebar/menu integration, enabled states, readable toolbars/tabs/status, keyboard focus and accessible light/dark layouts in TermForge's original design. Exact SecureCRT geometry and styling are no longer acceptance requirements. |
| UI-02 | Session Manager | Partial; E4, nested tree/filter and selection/open behavior | Match tree controls, context menu, pinned/auto-hide state, four docking edges, floating pane, and saved layout. |
| UI-03 | Active Sessions Manager | Missing; E5 | List all open sessions with active/count/state indicators; filter, multi-select, activate, disconnect, close, lock, and SFTP actions. |
| UI-04 | Tab groups and tiling | Partial; E3/E4, one tab strip or automatic tile grid | Independent horizontal/vertical groups with selectable tabs in each group; drag/reorder, resize, and restore grouping without recreating PTYs. |
| UI-05 | Multiple windows and tab movement | Missing; E5 | Move a live PTY between windows, clone into a new window, drag back, and close emptied windows without disconnecting moved sessions. |
| UI-06 | Snapshots | Missing; E5 | Save/open/update/delete named session sets with order, groups, tile sizes, and active tab; detect deleted profiles and restore predictably. |
| UI-07 | Session status and lock indicators | Partial; E4/E5, PTY-open/exited and log indicators | Distinguish process opened, transport connected, authenticated, disconnected, unread output, inactivity, locked, and running script without false connection claims. |
| UI-08 | Light/dark mode | Partial; E4/E5, explicit global light/dark selection | Follow system appearance when selected; compare every dialog/pane/control and keep terminal scheme independent. |
| UI-09 | Full screen, font zoom, automatic scaling | Partial; E5, native full screen and global font size | Font-only zoom/reset plus optional resize-driven font scaling; keep cells/PTY dimensions correct across displays. |
| UI-10 | Window transparency | Missing; E5 | Separate active/inactive opacity settings with readable dialogs and correct focus transitions. |
| UI-11 | Session Options / Global Options | Partial; E4/E5, small flat forms | Categorized option trees, correct defaults, inheritance, help, apply/cancel, scrolling, and persistent table widths. Inventory every 9.7 macOS page before claiming equivalence. |

## Saved sessions, connect workflows, and configuration

Sources: [session-management capabilities](https://www.vandyke.com/products/securecrt/key_features.html), [Connect Bar syntax](https://www.vandyke.com/support/tips/connectbar.html), [text import wizard](https://www.vandyke.com/support/tips/import-securecrt-sessions-from-csv-or-text-file-data-using-text-import-wizard.html), [9.7 release history](https://www.vandyke.com/products/history.php?prod=securecrt).

| ID | Capability | v0.2 status / evidence | TermForge acceptance gate still required |
| --- | --- | --- | --- |
| SM-01 | Named profiles and nested folders | Partial; E1/E4, up to 1,000 profiles, folders inferred from paths | Explicit empty folders; rename/move/copy/paste/duplicate sessions and folders; drag/drop; preserve references and test a large database. |
| SM-02 | Session search and refresh | Partial; E4, simple filter | Saved search options, manual refresh, path copying, and changes visible across app windows. |
| SM-03 | Multi-select / bulk editing / folder connect | Missing; E5 | Selection modifiers, mixed-value editing, atomic bulk updates, and one user action to connect selected/folder sessions. |
| SM-04 | Classic Connect dialog | Missing; E5 | Separate modal connection browser with selected session/folder actions, connect-in-tab/window choices, and remembered selection. |
| SM-05 | Quick Connect | Partial; E4/E5, new unsaved connection form | A dedicated temporary connection workflow using default options, correct protocol-specific fields, and an explicit save-session choice. |
| SM-06 | Connect Bar | Missing; E5 | Host/port/user/protocol parsing and saved-session completion; reject malformed inputs; no accidental password storage. |
| SM-07 | Default sessions / protocol defaults | Missing; E5 | Defaults apply to ad hoc and new sessions; explicit propagation to existing profiles; serial defaults tracked separately. |
| SM-08 | Auto sessions / restore last sessions | Missing; E5 | Optional startup sessions/folders and last-used restoration, including SFTP and local shells; preserve layout without surprise defaults. |
| SM-09 | Clone and reconnect as another user | Partial; E4/E5, reconnect same profile | Clone live profile independently, edit username/port before reconnect, preserve scrollback according to options. |
| SM-10 | Full configuration import/export | Partial; E1, Harbor JSON plus limited nonsecret SSH2 INI | Select sessions/settings/bars; preview; overwrite/merge/duplicate/new-only conflict policies; version migration and rollback. Proprietary encrypted secrets remain unsupported unless a documented interoperable export exists. |
| SM-11 | CSV/TSV/text import | Missing; E5 | Delimiter/field mapping, header/encoding handling, preview and errors before writing; escaped quotes/newlines and collision policies. |
| SM-12 | Configuration and personal-data folders | Partial; E1/E5, one app data directory and no vault | Relocatable configuration and separately protected personal data; sharing exports must not contain secrets. |
| SM-13 | URI handler / startup commands | Missing; E5 | macOS registration for supported URIs and launch-to-existing-window behavior, safely handling spaces and options. The grid labels general command-line options W/L, but 9.7 macOS history also documents terminal launches: exact macOS syntax needs live verification. |

## Protocols and SSH controls

Sources: [macOS SSH coverage](https://www.vandyke.com/products/securecrt/ssh_mac_terminal.html), [SSH/security feature grid](https://www.vandyke.com/products/securecrt/features.html), [host-key management](https://www.vandyke.com/support/tips/009.html), [agent behavior on macOS](https://www.vandyke.com/support/howto/002.html), [X11 forwarding](https://www.vandyke.com/support/tips/configuring-x11-forwarding-in-securecrt.html), [credential sets](https://www.vandyke.com/support/tips/how-to-manage-credentials-in-securecrt-securefx.html).

| ID | Capability | v0.2 status / evidence | TermForge acceptance gate still required |
| --- | --- | --- | --- |
| PR-01 | SSH2 transport | Partial; E1/E3, external OpenSSH | Version/capability discovery, explicit supported algorithms/options, accurate authentication state, connection diagnostics, cancellation, reconnect, and platform integration tests. |
| PR-02 | SSH1 | Missing; E5 | A separately selectable, explicitly identified legacy transport with fixture-based interoperability and no automatic downgrade from SSH2. |
| PR-03 | Telnet, RLogin, Raw TCP | Missing; E5 | Separate protocol adapters; Telnet negotiation/NAWS and commands, RLogin handshake, byte-preserving raw mode, timeout/cancel/reconnect tests. |
| PR-04 | Serial | Missing; E5 | Enumerate valid devices; baud/data/parity/stop/flow options; break and modem signals; separate serial defaults and disconnect/reconnect tests. |
| PR-05 | Hex View | Missing; E5 | Per-session byte-level hex/ASCII views with linked selections and optional ASCII hiding; do not reconstruct bytes from decoded text. |
| PR-06 | Local shell | Implemented for basic macOS workflow; E3 | Extend selectable executable/arguments/environment and verify interactive runtime on all target platforms. |
| PR-07 | IPv6 | Partial; E1/E5, accepted and formatted in destinations/forwarding | Loopback IPv6 fixtures for each implemented network protocol and bracketed URI/connect-bar input. |
| SH-01 | Password / keyboard-interactive / public keys | Partial; E3 password, E1 identity launch | Test interactive multi-step prompts, rejection, cancellation, key passphrases, and explicit authentication order. |
| SH-02 | Key formats and certificates | Partial; E5, external OpenSSH identity path | Establish tested RSA/Ed25519/ECDSA/DSA, PPK conversion, OpenSSH certificate and separate private-key locations; report unsupported client algorithms rather than claiming them. |
| SH-03 | Kerberos/GSSAPI authentication and key exchange | Missing as app controls; E5 | Provider discovery, per-session options, credential delegation controls, failure diagnostics, and an isolated integration environment. |
| SH-04 | Cipher / MAC / key-exchange selection | Partial; E5, external client defaults | Capability-aware algorithm lists and ordering; include 9.7 additions group15/group17 where backend supports them; fail clearly when unavailable. |
| SH-05 | Saved credential sets | Missing; E5 | Named referenced credentials, authentication order, optional username, forced selection prompt, and credential actions from keys/buttons/commands. |
| SH-06 | Password/passphrase caching | Missing; E5 | Opt-in lifecycle-bound caching, explicit removal, no plaintext configuration/export/log exposure, and reconnect/SFTP reuse tests. |
| SH-07 | Public-key creation/conversion/export | Missing; E5 | Generate and inspect keys, protect private-file permissions, convert supported formats, export public keys, and verify with an independent SSH server. |
| SH-08 | Public Key Assistant | Missing; E5 | Preview and install a selected public key through an authenticated connection; preserve unrelated authorized keys and provide clear failure/rollback behavior. |
| SH-09 | Agent management | Partial; E5, inherited system agent | List/add/remove/preload agent keys with fingerprint and source; macOS uses the system agent, so reflect externally added keys. |
| SH-10 | Agent forwarding | Missing; E5, explicitly disabled | Per-session opt-in and a multi-hop fixture proving forwarded authentication without copying private keys. |
| SH-11 | Host keys | Partial; E3, OpenSSH prompt/refusal | View/import/export/delete host-key entries and fingerprints with safe matching for nonstandard ports and hashed hosts; never equate spawn success with trust success. |
| SH-12 | X.509 / PKCS #11 smart cards | Missing; E5 | macOS provider/certificate discovery, PIN handling, certificate identity and host validation; use actual test tokens or clearly labeled emulators. Windows CAPI/PFX details are separate. |
| SH-13 | Local/remote/dynamic forwarding | Partial; E1 launch arguments, no tunnel integration | Listener/target controls, authenticated lifecycle, refusal/conflict reporting, multiplexed forwarding, IPv6, and data-flow tests. |
| SH-14 | X11 forwarding | Missing; E5, explicitly disabled | Per-session option and XQuartz-compatible authorization/display lifecycle with an isolated test application. |
| SH-15 | Compression | Missing as app control; E5 | Capability-aware compression setting and byte/throughput verification; do not expose a meaningless level unsupported by the backend. |

## Proxies and gateways

Source: [firewall categories and dependent sessions](https://www.vandyke.com/products/securecrt/features.html).

| ID | Capability | v0.2 status / evidence | TermForge acceptance gate still required |
| --- | --- | --- | --- |
| FW-01 | Named proxy/firewall configurations | Missing; E5 | Reusable references, explicit edit propagation, secret separation, and per-session selection. |
| FW-02 | SOCKS4 / SOCKS5 | Missing; E5 | Version selection, DNS mode, SOCKS5 authentication, IPv6 compatibility, rejection and timeout tests. |
| FW-03 | HTTP CONNECT | Missing; E5 | No-auth/basic authentication, correct destination framing, credential isolation, and response diagnostics. |
| FW-04 | TIS / Wingate | Missing; E5 | Protocol-specific Telnet negotiation and fixtures instead of reusing an SSH jump field. |
| FW-05 | Local proxy command | Missing; E5 | Explicitly configured executable/arguments, controlled subprocess ownership, stdin/stdout tunnel, and shutdown/error handling. |
| FW-06 | Dependent SSH sessions / jump gateways | Partial; E1, one OpenSSH `-J` hop | Reusable saved gateway sessions, independent authentication settings, gateway lifecycle, multi-hop dependencies, and cycle detection. |

## Terminal emulation, text, and keyboard behavior

Sources: [macOS terminal families](https://www.vandyke.com/products/securecrt/ssh_mac_terminal.html), [emulation feature grid](https://www.vandyke.com/products/securecrt/features.html), [mouse support](https://www.vandyke.com/support/tips/mousesupport.html), [color configuration](https://www.vandyke.com/support/tips/colorconfig.html), [key mapping](https://www.vandyke.com/support/tips/map-keyboard-shortcut-to-perform-menu-toolbar-function-securecrt.html), [keyword definitions](https://www.vandyke.com/support/scripting/scripting-examples/import-keyword-highlighting-ini-files.html), [9.7 additions](https://www.vandyke.com/products/securecrt/new-in.html).

| ID | Capability | v0.2 status / evidence | TermForge acceptance gate still required |
| --- | --- | --- | --- |
| TE-01 | Xterm and extensions | Partial; E4/E5, xterm.js default | Golden sequence tests for title, mouse, 256/24-bit color, alternate screen, and Xterm 216+/R6 keyboard modes. |
| TE-02 | VT100/102/220/320 | Missing as distinct emulations; E5 | Each mode must pass an independent sequence/key/character-set corpus; changing TERM alone is insufficient. |
| TE-03 | ANSI / SCO ANSI / Linux console | Missing as distinct emulations; E5 | Per-mode behavior and keyboard tests against representative server applications. |
| TE-04 | TN3270 / TVI910/925 / Wyse50/60 | Missing; E5 | Protocol/parser/keyboard semantics and fixture coverage for each family. |
| TE-05 | Character attributes / line drawing | Partial; E5, dependency-provided rendering | Test bold/underline/reverse/blink and line-drawing mappings; document unsupported combinations. Windows double-width/height is separate. |
| TE-06 | Unicode / legacy encodings / RTL | Partial; E5, UTF-8 path | Per-session encoding with streaming decoder boundary tests; CJK widths/combining marks and RTL reading/order comparison. |
| TE-07 | Rows/columns, 80/132 switching, rewrap | Partial; E1/E4, fit/PTY resize only | Fixed geometry and resize policy, 80/132 mode with font choice, remote window-size notification, and scrollback rewrap tests. |
| TE-08 | NRCS | Missing as selectable setting; E5 | Implement and test host-selected national replacement sets per supported terminal family. |
| TE-09 | Raw protocol display | Missing; E5 | Diagnostic display preserving/control-escaping input rather than applying normal terminal interpretation. |
| TE-10 | Color schemes | Partial; E5, two global palettes | Named per-session scheme, foreground/background and ANSI colors, Solarized/system modes, import/export, live editing. |
| TE-11 | Scrollback | Partial; E1/E5, configured maximum 100,000 | Offer the target 128,000-line range, per-session settings, bounded memory, selection/copy/printing and resize stress tests. |
| TE-12 | Per-session mapped keys | Missing; E5, fixed app shortcuts only | Map arbitrary combinations to strings, scripts, menu/scroll actions, protocol commands, or external applications; priority over base keyboard map. |
| TE-13 | Emacs/Meta and alternate keyboard | Missing as options; E5 | Configurable Option/Alt Meta handling, function keys, backspace/delete/newline, and mode-dependent keypad sequences. |
| TE-14 | Persistent keyword highlighting | Missing; E5 | Literal/phrase/substring/regex rules with independent colors/bold/reverse, named sets, live changes, and scrollback coverage. |
| TE-15 | Ad hoc keyword toolbar | Missing; E5 | Temporary phrase entry, clear/toggle, and correct 9.7 macOS accelerator behavior; distinguish this from terminal Find. |

## Command tools, clipboard, and logon automation

Sources: [Command Window](https://www.vandyke.com/support/tips/chatsendcom.html), [Button Bar functions](https://www.vandyke.com/support/tips/buttonbar.html), [session-specific bars](https://www.vandyke.com/support/tips/button_bar.html), [Command Manager interoperability](https://www.vandyke.com/support/tips/transfer-button-bars-to-the-securecrt-command-manager.html), [copy/paste mouse options](https://www.vandyke.com/support/howto/010.html), [general behavior grid](https://www.vandyke.com/products/securecrt/features.html).

| ID | Capability | v0.2 status / evidence | TermForge acceptance gate still required |
| --- | --- | --- | --- |
| CO-01 | Command Window targets | Partial; E3/E4, active/all-live with confirmation | Active/all/selected-group/visible targeting, locked-session exclusion, and exact target preview; retain explicit safeguards for multi-session sends. |
| CO-02 | Command history / immediate characters | Missing; E5 | Configurable persistent history and edit/recall; optional live characters, Ctrl+C, escape and completion forwarded to explicit targets. |
| CO-03 | Button Bar | Partial; E4/E5, snippets insert for review | Named/session-specific bars; action types, escaped strings, args, color, editing/reorder, and import/export. |
| CO-04 | Command Manager | Missing; E5 | Dockable named command/folder tree, filter, double-click/Enter execution, editing, and copy between manager and bars. |
| CO-05 | Clipboard modes | Partial; E4/E5, copy/plain paste | Row/column selection, auto-copy, right/middle paste, ANSI-preserving copy, and macOS shortcut conventions. |
| CO-06 | Multi-line paste review | Partial; E5, confirmation with noneditable preview | Editable/resizable preview with per-session options; cancel sends zero bytes and accept sends precisely edited text. |
| CO-07 | URL open / selection lookup | Missing; E5 | Detect and open allowed URLs or search selected text only on an explicit user gesture; do not execute terminal-supplied commands. |
| CO-08 | Automated logons / expect-send actions | Missing; E5 | Ordered prompt matching, timeout/cancel, credentials reference, optional trailing CR, and no secret trace output. |
| CO-09 | Remote command at connect | Missing; E5 | Execute a configured remote command after authentication; terminal/no-shell handling and exit state tested. |
| CO-10 | Local command before connect | Missing; E5, `PermitLocalCommand=no` | User-configured explicit command with args, exit/timeout handling, and no inherited SSH configuration surprise. |
| CO-11 | Anti-idle | Missing; E5 | Protocol keepalive or explicit string timer, session-specific enablement, no sends after disconnect/lock. |
| CO-12 | Character/line/prompt delays | Missing; E5 | Cancellable paced sends, line pacing, and prompt-gated delivery, including paste and ASCII sends. |
| CO-13 | Password-based session locking | Missing; E5 | Lock input/close/actions/broadcast, optionally hide output, unlock explicitly, and retain locked state across manager/tab/window changes. |

## Transfers and related tools

Sources: [SSH transfer options](https://www.vandyke.com/products/securecrt/ssh_file_transfer.html), [SFTP tab escape sequence](https://www.vandyke.com/support/tips/sftptab.html), [9.7 SFTP changes](https://www.vandyke.com/products/securecrt/new-in.html), [TFTP details](https://www.vandyke.com/support/tips/securecrt-tftp-server.html), [SecureCRT/SecureFX installation on macOS](https://www.vandyke.com/support/tips/install-securecrt-and-securefx-on-a-macos-machine.html).

| ID | Capability | v0.2 status / evidence | TermForge acceptance gate still required |
| --- | --- | --- | --- |
| FT-01 | Interactive SFTP tab / direct open | Partial; E1/E4, separate system `sftp` process | Real upload/download/list/path/completion tests; open saved SSH session directly as SFTP; report actual authentication state. |
| FT-02 | SFTP shared transport | Missing; E5, SSH multiplexing disabled | Reuse an authenticated SSH transport without reprompting; manage lifetime and working-directory handoff predictably. |
| FT-03 | Drag/drop SFTP | Missing; E5 | Explicit destination/overwrite review, multiple files, path escaping, progress/cancel/error handling; never interpret local paths as shell commands. |
| FT-04 | Xmodem / Ymodem / Zmodem / Kermit | Missing; E5 | Independently tested protocol engines, binary fidelity, checksums, retries, abort, batch behavior, and PTY ownership. |
| FT-05 | Send/receive ASCII | Missing as transfer operation; E5, raw output log is different | File selection, encoding, pacing, receive start/stop and destination review; preserve binary-transfer distinction. |
| FT-06 | Send Binary | Missing; E5 | Byte-exact file-to-transport send with progress, cancellation, and terminal-decoder isolation. |
| FT-07 | Built-in TFTP server | Missing; E5 | Separate read/write roots, IP restrictions, overwrite policy, traversal protection, log, start/stop, and platform port-binding solution. |
| FT-08 | SecureFX-related workflow | Missing; E5 | Track reusable session/trust/authentication handoff to an independent file-transfer component. SecureFX graphical FTP/FTPS/HTTPS/S3/WebDAV/SCP is a separate product, not evidence of SecureCRT's own SFTP browser. |

## Scripting, logs, printing, and application lifecycle

Sources: [Python on macOS](https://www.vandyke.com/support/tips/how-to-use-python-scripting-securecrt-on-macos.html), [scripting objects](https://www.vandyke.com/support/scripting/scripting-examples/python-importing-custom-modules-referencing-the-crt-object.html), [automated logging](https://www.vandyke.com/support/tips/configure-automated-logging-in-securecrt.html), [trace logging](https://www.vandyke.com/support/tips/configure-trace-options-debug-logging-in-securecrt.html), [9.7 log pause/import changes](https://www.vandyke.com/products/history.php?prod=securecrt), [printing/application grid](https://www.vandyke.com/products/securecrt/features.html).

| ID | Capability | v0.2 status / evidence | TermForge acceptance gate still required |
| --- | --- | --- | --- |
| AU-01 | Python automation | Missing; E5 | External runtime discovery, safe process ownership, run/cancel/status, script arguments and error reporting on macOS. Validate supported runtime versions explicitly. |
| AU-02 | Session/screen/tab/config/dialog/file API | Missing; E5 | Document an independent API for connect, send, read/wait/prompt, tabs, settings, dialogs, transfers, and cancellation; separately test any intended `crt` compatibility rather than assuming it. |
| AU-03 | Script recorder | Missing; E5 | Record printable/control/function-key inputs and waits; generate editable Python; exclude passwords and verify replay only against fixtures. |
| AU-04 | Standalone CLI utilities | Partial via installed OS `ssh`/`sftp`; E5 | Harbor-owned documented launch/config/session/transfer/key commands, exit codes, unattended mode, and platform integration tests. |
| LG-01 | Manual session log | Partial; E2/E4, raw output into new file, 128 MiB stop | Raw/plain modes, append/overwrite policy, pause/resume same file, IO errors, and explicit sensitive-output notice. |
| LG-02 | Automatic log / timestamps / custom records | Missing; E5 | Connection/line/disconnect records, start timing appropriate to protocol/authentication, multiline decoder boundaries, and timestamps. |
| LG-03 | Filename substitutions / folder creation / rotation | Missing; E5 | Deterministic session/host/date/time substitution, safe path generation, directory creation, midnight rotation, and clock-change tests. |
| LG-04 | Trace / packet diagnostics | Missing; E5 | Opt-in levels and connection/authentication diagnostics; redact secrets and keep byte dumps separate from ordinary logs. |
| LG-05 | Log path on launch | Missing; E5 | Document macOS launch syntax and verify it for spaces, collisions, permission errors, and existing-window dispatch. |
| PT-01 | Screen / selection / automatic print | Missing; E5 | Preview/print each source, pagination, Unicode/color, cancel, and printer errors. |
| PT-02 | Host-directed printing | Missing; E5 | Explicit opt-in handling of host print control sequences with a test spooler and no unexpected printer jobs. |
| PT-03 | Global/session printer configuration | Missing; E5 | Margins/font/printer and host-print settings with inheritance and output fixtures. |
| AP-01 | Cross-platform delivery | Partial; E6 | Interactive startup/PTY/protocol/UI tests on macOS ARM64/Intel, Windows x64, Linux x64; document minimum OS/tool requirements. |
| AP-02 | Automatic update checks | Missing; E5 | User-controlled version check with clear prerelease/stable channel and no silent installation; future updater requires verified release provenance. |
| AP-03 | Help and accessibility | Partial; E4/E5, brief help and basic ARIA/focus | Searchable offline help per dialog/action, keyboard-only workflows, macOS VoiceOver and accessibility audits; no certification implied. |

## Platform-specific requirements and product integration

The [official platform grid](https://www.vandyke.com/products/securecrt/features.html) and [key-feature footnote](https://www.vandyke.com/products/securecrt/key_features.html) identify these distinctions. TermForge's independent visual design does not change the project's feature scope. Windows-only capabilities below are missing Windows requirements, and integration with a separate product remains a compatibility gap where applicable. Their absence cannot be treated as completion of the overall goal.

| Capability | SecureCRT applicability | Harbor v0.2 status | Tracking decision |
| --- | --- | --- | --- |
| RDP tabs/tiles | Windows | Missing | Separate Windows target. |
| Telnet/TLS (Telnet/SSL) | Windows | Missing | Separate Windows target; ordinary Telnet belongs in macOS PR-03. |
| TAPI/modems and Windows named pipes | Windows | Missing | Separate Windows transport target. |
| Scratchpad and script editor tabs | Windows | Missing | Separate Windows target; optional portable equivalents can be original features. |
| ActiveX languages / COM VRALib | Windows | Missing | Separate Windows compatibility scope; macOS automation target is Python. |
| Graphical keymap editor | Windows | Missing | Separate Windows convenience; macOS mapped-key functionality still required. |
| Drag/customizable menu and toolbar, file-based UI customization | Windows | Missing | Separate Windows target; native menu integration and usability remain UI-01. |
| Colored tab backgrounds | Windows | Missing | Track configurable tab colors separately from status indicators; TermForge's visual design is independent of the historical macOS reference. |
| Double-width/height font attributes | Windows | Missing | Separate Windows emulation extension. |
| Environment-variable paths | Windows in feature grid | Missing | Separate Windows option; verify individual macOS log/path behavior from its own documentation. |
| FIPS 140-2 mode / validated library | Windows | Missing | No Harbor validation claim; selecting algorithms never establishes certification. |
| CAPI store / PFX-specific X.509 details | Windows | Missing | Separate Windows provider integration; macOS PKCS #11 remains SH-12. |
| MSI/Group Policy installer conveniences | Windows | Missing; NSIS/portable builds exist | Separate Windows packaging target. |
| Section 508 product registration | Windows in grid | Not established | Harbor accessibility testing is required independently; certification cannot be inherited. |
| SecureFX protocols and graphical file management | Separate application on all desktop platforms | Missing | Track session/trust/authentication handoff as an integration compatibility gap; separately distinguish SecureFX's full feature catalog from features native to SecureCRT. An independent file component does not establish actual SecureFX interoperability. |
| Trial/registration, purchased updates/support/maintenance | Commercial service | Not applicable | Harbor is MIT/free; do not reproduce license enforcement or promise vendor support. |

## Released preview: TermForge v0.3.0

The current project is named TermForge. This addendum was inspected on October 12, 2026 and describes the preview released from commit `09abaaefbb440d0600647ac389e32f72dca98700`; it does **not** change the v0.2 baseline above or the public v0.2 release. Interactive native Electron runtime testing of 0.3 remains pending on every platform. Socket/Python tests, headless renderer checks and native packaging verify different boundaries, stated below.

### New evidence

| Key | Source and verification boundary |
| --- | --- |
| N1 | `tests/transports.test.cjs` contains 14 cases. TCP/Telnet cases use actual loopback TCP servers; serial cases use injected adapters and the installed `SerialPortMock` with real binding lifecycle. They exercise negotiation, fragmentation, NAWS/IAC escaping, break, refused connections, limits, timeout/cancel, and native-binding close/retry handling. No physical USB/serial device or remote network device was tested. |
| N2 | `tests/tftp.test.cjs` contains 15 cases using real UDP loopback sockets and temporary synthetic files: byte fidelity, zero blocks, duplicate/retry handling, unknown transfer IDs, IP filtering, path/symlink rejection, upload publication collisions, limits, partial cleanup, stop/restart, and pending setup shutdown. Not a LAN-device interoperability test. |
| N3 | `tests/automation.test.cjs` contains 18 cases that launch actual local Python interpreters. They cover framing/Unicode, wait/read/timeout, cancellation/forced termination, limits, errors, screen/tab callbacks, reconnect references, and generated recording execution. Terminal, session, and rendered-screen integration callbacks in this suite are controlled fixtures; this does not certify automation against authenticated SSH sessions. |
| N4 | `tests/options.test.cjs` contains 7 cases for protocol/options validation, discrete OpenSSH arguments, migration without rewriting old bytes, atomic bulk edits, snapshot reference remapping, bounded command history, and terminal/literal-keyword settings. `tests/keymap.test.cjs` contains 6 cases for escape parsing, modifier matching, macOS Option input, composition exclusions, duplicates, and action allowlists. SSH option construction is not remote authentication/forwarding verification. |
| N5 | `scripts/ui-check.cjs` and `scripts/ui-fixture.cjs` provide repeatable headless Chromium checks. The locally inspected final `work/termforge-ui-qa/report.json` records **46 passed, 0 failed, no console errors**, including TFTP start/stop, request validation, failed-start recovery, and safe transfer-status text. The bridge simulates terminal/process/script/transfer activity; it uses actual configuration validators, Python-recording generation and TFTP constructor validation, but does not launch Electron, connect a remote host, access serial hardware, start the TFTP server, or serve files. |
| N6 | Source inspection of `app/transports.cjs`, `app/tftp.cjs`, `app/automation.cjs`, `app/termforge_script.py`, `app/keymap.cjs`, and the new renderer modules confirms the handlers are wired to functional subsystems. The fresh complete local backend run passed **84/84 tests, 0 failures, 0 skipped**. It exercised the new source, not the previously published binaries. Build success alone will not advance native-runtime evidence. |
| N7 | [Native CI](https://github.com/distractedagain/termforge/actions/runs/38320236458) and [package builds](https://github.com/distractedagain/termforge/actions/runs/38320240854) succeeded at `09abaaefbb440d0600647ac389e32f72dca98700`. Both Mac architectures and Linux passed 84 backend tests each without skips. Windows passed 81, with POSIX forced-termination and two symlink checks skipped; TFTP symlink coverage ran successfully. Linux passed 46 headless renderer checks. Both Mac packages passed strict recursive ad-hoc signature verification. No job opened an interactive Electron window. |
| N8 | [Publisher run](https://github.com/distractedagain/termforge/actions/runs/38320923229) succeeded and [v0.3.0](https://github.com/distractedagain/termforge/releases/tag/v0.3.0) is public/prerelease with 13 uploaded assets: eight packages, four platform build records, and SHA256SUMS.txt. The publisher hashed every package and checked exact tag/build provenance before publishing. Public checksums and all four build records were independently downloaded without authentication; their hashes matched GitHub's release-asset digests, and every build record referenced the exact released commit. macOS remains unnotarized; Windows remains unsigned. |

### Changes and current parity limits

Each row remains **Partial** for the complete referenced requirement. The narrow new functions can be exercised, but the original acceptance gates above still apply.

| Related IDs | Implemented in current source | Evidence | Remaining differences / next gate |
| --- | --- | --- | --- |
| UI-01, UI-11 | macOS hides the duplicate in-window menu row; compact toolbar, vertical manager selectors, categorized Session/Global Options; native Script menu | N5/N6 | Still needs a running 9.7 macOS reference comparison for every menu/dialog/default/shortcut and native focus behavior. No visual-equivalence claim. |
| UI-02, UI-03 | Session/Command/Active managers share a dock area. Active list filters sessions and supports activate/clone/reconnect/close with an open-session count | N5/N6 | No floating/four-edge docking or auto-hide; active manager lacks multi-select/lock and authenticated transport-state detection. |
| UI-04, SM-09 | Tabs reorder with drag events, clone sessions, and tile horizontally/vertically/as a grid | N5/N6 | No independent tab groups or live-tab movement across windows. Cloning opens another transport; it does not clone shell process state. |
| UI-06 | Snapshots save ordered references to saved sessions, tile orientation and active profile; select without connecting, then explicit reviewed connect | N4/N5/N6 | Clones with the same profile ID are deduplicated; unsaved connections excluded. No tab groups, repeated profile instances, pane sizes, or complete workspace restoration. |
| SM-03 | Multi-selection, reviewed folder/selection connect, atomic bulk updates of selected folder/username/font/color fields | N4/N5/N6 | Bulk edit covers only those fields; no full mixed-value settings editor or explicit empty-folder management. |
| SM-05, SM-06 | Dedicated Quick Connect with opt-in save; Connect Bar accepts saved names and basic SSH/Telnet/Raw address forms | N5/N6 | Does not implement the complete SecureCRT command-line language, multiple connect expressions, all shortcut variants, or OS URI-handler registration. Embedded passwords are deliberately rejected. |
| SM-10 | Version-1 configuration migrates in memory to version 2; TermForge JSON includes advanced settings/commands/history/snapshots and remaps imported references | N4/N6 | Limited nonsecret INI importer remains SSH2-only. CSV/text wizard, proprietary XML settings compatibility, selected-category exports, and full conflict policies remain missing. |
| PR-03 | Actual Telnet and Raw TCP adapters replace subprocess placeholders; Telnet handles terminal type, NAWS, echo, IAC, fragmented negotiation/NVT state, and break | N1/N6 | RLogin missing. No separate raw diagnostic/byte display, TLS, proxy support, or every Telnet option. Text API decodes UTF-8; it is not a byte-exact binary transport API. |
| PR-04 | Serial device enumeration and configurable baud/data/stop/parity/flow settings, input/output, and break. Closing waits for confirmed release; failed native closes remain tracked and retryable | N1/N4/N5/N6 | Physical serial adapters, permission/device-removal cases, platform-native runtime, separate serial default profiles, modem-signal control UI, and Hex View remain unverified/missing. |
| SH-02–04, SH-10, SH-14–15, CO-09, CO-11 | SSH options for certificate path, preferred authentication, cipher/KEX/MAC names, agent/X11 forwarding, compression, server keepalive, timeout, and remote command produce separate OpenSSH arguments | N4/N5/N6 | Installed OpenSSH determines capabilities. No dynamic capability discovery or verified GSSAPI/KEX/token/certificate/X11/agent/remote-command integration; no credentials vault or authentication-state detector. Keepalive applies to SSH, not every protocol. |
| TE-01, TE-07, TE-10–11, TE-13 | Per-session/global font/scheme/scrollback/cursor settings; 128,000-line setting range; local echo, Backspace/Delete modes, Option/Alt Meta, word separators and visual bell | N4/N5/N6 | TERM/terminal-type choices still use one xterm.js renderer: they do not implement distinct VT/ANSI engines. Fixed geometry/80–132 switching, legacy encodings/RTL, custom scheme editor, and memory/scrollback stress comparisons remain. |
| TE-12 | Session key editor captures combinations; text/control escapes and allowlisted menu actions run through validated dispatch | N4/N5/N6 | Only send-text/menu action types; no direct script args, scrollbar/protocol/external-program mapping or imported alternate keymap. Native keyboard routing still needs interactive verification. |
| TE-14–15 | Global persistent literal rules and temporary toolbar keyword; foreground/background decorations follow writes/scroll/resize | N4/N5/N6 | At most 32 literal rules, 128 characters each, visible rows and 512 decorations; no regex, bold/reverse attributes, named per-session sets or full scrolling-history equivalence. |
| CO-02–04 | Bounded configurable Command Window history; nested Command Manager with filter and Enter/double-click send; command folder/color/named Button Bars share stored command definitions | N4/N5/N6 | No immediate-character mode or selected-group/visible targeting. Bars support command strings only, not the full action catalog/session-specific switching or manager/bar copy operations. |
| CO-05–06 | Copy on select, right-click paste, configurable multiline confirmation and word selection; cancel sends nothing | N4/N5/N6 | No middle-click/ANSI-preserving copy. Multiline preview still is not an editable/resizable paste editor. |
| FT-05, LG-01 | Send ASCII file loads text and previews exact content before sending; session logs can pause/resume their existing file | N5/N6 | No character/line/prompt pacing, receive-ASCII operation, transfer progress or binary send. Logs remain raw/new-file-only with size cap; no plain/append/automatic timestamps/rotation. |
| FT-07 | Original octet TFTP server and explicit start/stop dialog with selected-folder token, allowed client IP, bind address/port, upload toggle and transfer status | N2/N5/N6 | One shared root, new files only, ASCII relative names, 64 MiB/file and eight transfers. No separate upload/download roots, overwrite option, auto-start, privileged-port helper or device interoperability evidence. UI defaults to loopback UDP 6969 and requires an explicit allowed client. |
| AU-01–02 | Installed Python runner; limited `crt` send/wait/read, screen rectangles/coordinates, saved-session connect, tab collection/activate/clone/close, args, Sleep and responsive cancel | N3/N5/N6; `docs/PYTHON-AUTOMATION.md` | One script at a time; no `crt.Dialog`, session configuration object, `Get2`/`IgnoreEscape`, file-transfer API, or full script compatibility. `Session.Connected` means terminal availability, not verified SSH authentication. |
| AU-03 | Explicit input recording; review/remove events before export; generator emits executable Python with recorded input strings and pauses | N3/N5/N6 | Records any input, including secrets typed while enabled; review is required. No automatic credential detection or reliable prompt-wait inference. Replay equivalence and real SSH interaction remain to test. |

### Major remaining work at the 0.3 checkpoint

- Complete native macOS visual/interaction comparison, independent tab groups/multiple windows, floating/auto-hide docking, comprehensive option defaults and session locking.
- Credentials, passwords/passphrase lifecycle, key/host-key/token management, SSH capability discovery and integration tests for authentication/certificates/GSSAPI/forwarding/proxies; SSH1 and RLogin remain missing.
- Distinct terminal-emulation engines and keyboard modes, TN3270/Wyse/TVI/SCO support, legacy encodings, NRCS, geometry modes, raw bytes/Hex View, regex/attribute keyword sets.
- Real SFTP integration and transport reuse, drag/drop, X/Y/Zmodem/Kermit, receive-ASCII/binary transfers, TFTP device/platform interoperability and requested server-option parity.
- Full Python object/API and script compatibility, prompt-aware recording, complete Command Window/Button Bar action modes, CSV/settings migration, automatic logging/rotation/trace and printing.
- Windows-specific feature work, including RDP, ActiveX/COM compatibility, Windows keymap/editor conveniences and applicable transport/provider integrations, remains part of the overall goal despite the macOS visual reference. Current-version native runtime evidence on every requested OS/architecture, accessibility testing, signed/notarized distribution and version-specific public release verification also remain. Published v0.2 packages do not verify new v0.3 code.

Local verification at this checkpoint: **84/84 backend tests and 46/46 headless renderer checks passed**. Native CI, packaging and public v0.3 publication were verified at the exact released commit, as recorded in N7/N8. Interactive packaged runtime and the remaining acceptance gates are still pending. Keep version-specific verification boundaries; neither a test count nor a successful screenshot is a feature-parity certification.

## Color-scheme update: TermForge 0.4 preview

The shared palette catalogue now supplies seven named presets, including canonical Solarized Dark and Light. Every preset defines foreground/background, all sixteen ANSI slots, cursor/accent and active/inactive selection colors. Options → Color Schemes and a palette toolbar button expose preview-only selection, keyboard navigation, Apply/Cancel and recoverable save errors. Global and per-session appearance pages share the same catalogue and ANSI previews; Multiple Session Options offers every preset for future connections.

A global scheme updates inheriting live terminals, including their surrounding background. Explicit session overrides remain intact. Saving Session Options updates the matching saved session's open terminals, or the exact originating unsaved terminal, without replacing its transport. Optional interface matching follows the global palette; disabling it restores the saved independent light/dark interface.

The local backend suite passed **92 tests** with no failures or skips. Eight palette tests cover canonical ANSI values, cursor/selection contrast, inheritance, strict setting validation, persistence/import/export and older configuration loading. The renderer passed **63 headless checks** with no failures or console errors, including actual ANSI cell colors, live saved/unsaved-session targeting, optional matching chrome, preview cancellation, save errors, and compact picker layout. These use a synthetic bridge. These changes advance TE-10, but custom palette editing, external palette import, full SecureCRT appearance equivalence and packaged color testing remain unverified or incomplete.

Version 0.4 [native CI](https://github.com/distractedagain/termforge/actions/runs/38324020057) and [packaging](https://github.com/distractedagain/termforge/actions/runs/38324019614) passed at tagged commit `0e9ae540293fac90d0c31649705fed6fdb2f2df3`: Mac ARM64/Intel and Linux passed 92 tests each, Windows passed 89 with three POSIX-only skips, and Linux passed 63 headless checks. Both Mac packages passed strict recursive ad-hoc signature verification. The Windows package job needed one unchanged-source retry after timing failures. [Publication](https://github.com/distractedagain/termforge/actions/runs/38325248387) verified eight packages, four source records and the checksum manifest. Independent anonymous downloads confirmed the records and all listed hashes against public asset digests. These checks establish source/build provenance, not interactive packaged color behavior.

Separately, the user reported that installed v0.3 opened on macOS and that local-shell and SSH use worked. This is limited user-reported runtime evidence, not a full native test matrix or evidence for v0.4.

## Tab groups and snapshots: TermForge 0.5 preview

UI-04 and SM-07 advance with independently selected tab groups, nested vertical/horizontal splits, pointer/keyboard divider resizing, tab drag between groups, edge-drop splitting, group collapse and reconnection in place. Existing tile commands create one group per connection. The same terminal objects and processes are retained during rearrangement.

Snapshots store repeated saved-session instances, tab/group order, per-group active tabs, focused group and split ratios. Restoring adds the new groups beside current tabs. Failed opens are reported and omitted from the resulting layout; successful connections remain usable. Older snapshots remain readable, imported profile collisions remap every instance, and profile deletion repairs the remaining tree. Unsaved quick connections, terminal output and running process state are excluded.

Local verification passed **115 backend tests and 72 headless interface checks** with no failures or browser console errors. Twelve snapshot tests validate persistence, imports, deletions, bounds and malformed layouts. Eleven pure layout tests cover lifecycle and a deterministic mixed-operation sequence. The headless suite checks real xterm rendering through a synthetic bridge, including duplicate restoration, retained output, per-group focus, resizing after movement, delayed reconnect with close-on-exit, and partial failures. `docs/UI-VERIFICATION.md` records this scope. No Electron window was launched locally.

These rows remain partial: live tab movement across windows, selected-group command targeting, automatic startup restoration, floating managers and complete native reference comparison remain open. Earlier baseline rows and versioned test counts describe their respective releases.

Version 0.5 [native CI](https://github.com/distractedagain/termforge/actions/runs/38328313996), [packaging](https://github.com/distractedagain/termforge/actions/runs/38328332260), and [publication](https://github.com/distractedagain/termforge/actions/runs/38328921919) passed first attempt at `a3697bcbb7c803edfde80d23e5c5769c621671ba`: both Macs and Linux passed 115 tests, Windows passed 112 with three POSIX-only skips, and Linux passed 72 headless checks. Both Mac package signatures passed strict recursive ad-hoc verification. All thirteen public assets were checked against the manifest and public digests; anonymous build-record downloads matched the tagged source. Interactive packaged behavior remains unverified.

## Current visual direction: TermForge 0.7 source

The 0.7 source introduces an original slate/teal workspace, horizontal manager switcher, vector icons and app mark, welcome actions, and refined dialogs and AI Assistant. Light/dark modes and optional matching palettes remain available. Existing session, tab-group, command and explicit AI-review workflows remain in scope; the redesign does not complete missing feature rows. See [the interface guide](MODERN-INTERFACE.md).

The current source passed **156 backend tests**. Final interface verification, native packaging and publication are pending. Visual-equivalence requirements in the historical 0.3–0.5 notes are superseded by the current UI-01 and completion gates below; their recorded results remain unchanged.

## Required comparison and completion gates

1. Inventory remaining SecureCRT 9.7 actions, defaults and shortcuts from public documentation or an authorized running installation, including applicable platform differences. Reference captures support functional analysis; redact user data and do not bundle reference artwork.
2. Attach each action/default/shortcut to a row. Verify TermForge's original interface with synthetic profiles/output at desktop and compact sizes, in light/dark and matching palettes. Check readable text, reachable controls, keyboard focus, accessibility and state changes. Exact reference positions, dimensions and styling are not completion gates.
3. Use real isolated servers, loopback sockets, serial emulators, and transfer fixtures for behavior. Cover success, cancellation, rejection, timeout, reconnect, malformed data, and binary fidelity on applicable platforms.
4. Record original implementation and repeatable evidence for every requested row and its variations on each applicable platform, including the Windows-specific section. Obtain independent terminal/security review before production claims. Mark intentionally unsupported legacy/security combinations visibly rather than hiding the gap.
5. Publish only accurate version-specific release notes. Until these gates are met, the description remains **an independent terminal application with an original modern interface, being developed toward SecureCRT 9.7 feature parity across macOS, Windows, and Linux**.
