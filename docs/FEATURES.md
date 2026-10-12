# Feature map

TermForge is an independently written, MIT-licensed terminal client. It uses public feature descriptions and original code, not VanDyke source code, disassembly or artwork. SecureCRT 9.7 macOS is the visual reference; the overall feature goal covers every applicable capability on macOS, Windows and Linux. The [sourced parity ledger](SECURECRT-PARITY.md) tracks requirements and gaps without claiming complete equivalence.

## Current development scope — TermForge 0.3.0, unreleased

| Workflow | TermForge implementation | Limits |
| --- | --- | --- |
| Desktop | Electron with native PTYs and socket/device adapters | New 0.3 native CI/package/interactive runtime verification pending |
| Terminal | xterm.js scrollback, selection, resize, search, per-session fonts/schemes/cursor | TERM hints do not create distinct VT/ANSI engines; specialized emulations remain missing |
| Local shell | Operating-system shell in node-pty | Uses the user's environment and permissions |
| SSH | Installed system OpenSSH | Installed client/server determine authentication and algorithm support; no authentication-state detector |
| SFTP / ASCII | Interactive system SFTP and reviewed ASCII text file send | No shared SSH transport, drag/drop transfer, graphical browser, receive ASCII or binary send |
| Telnet / Raw TCP | Original adapters; Telnet option/NAWS/terminal-type/echo handling and break | UTF-8 text stream; real loopback tests, no external-device interoperability coverage |
| Serial | Device enumeration, baud/data/stop/parity/flow options, streaming/break, asynchronous close/retry | Mock/injected adapter tests; no physical hardware/native OS verification or Hex View |
| Saved sessions | Nested inferred folders/filter, Quick Connect, Connect Bar, selected/folder connect and selected-field bulk edits | Up to 1,000 profiles; no explicit empty folders, complete bulk option catalog or default/auto session system |
| Workspace | Reorder/clone tabs, horizontal/vertical/grid tiles, Active Sessions list | Up to 32 open terminals; no independent tab groups, floating managers, live-tab multi-window movement or locking |
| Snapshots | Saved-profile order, tile orientation and active profile | Cloned profile IDs deduplicated; unsaved sessions and detailed pane/group geometry excluded |
| Commands | Nested filtered Command Manager, named Button Bars, folder/color and bounded history | Command strings only; no full button action catalog, session-specific bars or immediate-character mode |
| Broadcast | Explicit review and confirmation for active/all-live targets | No selected-group/visible targeting; commands use each target's current shell state |
| Logging | Opt-in raw output into a new file, pause/resume | 128 MiB limit; may include secrets; no plain/append/automatic timestamps/rotation |
| Appearance | macOS native menu, compact toolbar, vertical managers, categorized settings, Command Window/Bar/status | Exact menu/dialog/default/shortcut equivalence remains unverified |
| Keys / highlighting | Session text/menu key mappings, Option/Alt Meta, Backspace/Delete; literal rules and temporary keyword | Limited action types; no regex/bold/reverse or named per-session sets |
| Python / recording | Installed interpreter with send/wait/read/tab/screen subset, cancel/output and reviewed input recording | No full script compatibility, Dialog/config/file-transfer API or inferred prompt waits; see [API limits](PYTHON-AUTOMATION.md) |
| TFTP | Explicit restricted octet downloads and opt-in new-file uploads, root/client/bind/port and status | One root, no overwrite, loopback 6969 default, no privileged-port helper; see [TFTP limits](TFTP.md) |
| SSH controls | Identity/certificate paths, auth preference, algorithm names, agent/X11 forwarding, compression, keepalive and remote command | Construction tests only for new controls; no key/token/vault management or verified certificate/GSSAPI/forwarding integration |
| Jump / tunnels | One OpenSSH jump and loopback-requested local/remote/dynamic forwarding | No gateway session graph/multiple hops; server policy may reject or alter forwarding |
| Configuration | Version-2 JSON with version-1 schema migration, commands/history/snapshots; limited plain SSH2 INI import | No CSV/text wizard, broad XML compatibility, encrypted-secret recovery or full conflict-policy UI |

## Remaining gaps

SSH1, RLogin, Telnet/TLS, Windows RDP/ActiveX/COM behavior, distinct TN3270/Wyse/TVI/SCO and other emulations, full credential/key/host-key management, advanced named proxies, X/Y/Zmodem/Kermit, printing, automatic logging/rotation, complete automation compatibility, and SecureFX integration remain missing or incomplete. The macOS layout choice does not remove applicable Windows/Linux capabilities from the overall goal.

The limited INI reader imports nonsecret SSH2 connection metadata, not passwords, authentication databases, scripts or complete settings. Review imported hosts, ports, usernames, folders and key paths before connecting; conservative validation may reject unusual values, and Windows key paths can require changes on another platform. SSH config aliases/proxy commands are not inherited.

JSON import adds sessions and assigns fresh IDs on collisions, remapping snapshot references. Included preferences, commands and history update their corresponding configuration. Both import paths validate before writing and do not connect automatically. Version-1 migration concerns file schema; it does not promise migration of every historical application data directory.

## Verification and distribution

On October 12, 2026, the 0.3 feature batch passed **84 local backend tests and 46 headless renderer checks**, with zero failures and no browser console errors. Transport/TFTP tests use real TCP/UDP loopback sockets. Python tests launch an actual interpreter with controlled session/screen callbacks. Serial tests use injected adapters and the installed mock binding. Headless checks use a synthetic bridge and actual validators/code generation; they do not launch Electron or perform real remote connections, scripts or transfers.

Historical Harbor 0.1 macOS Intel checks established real local PTYs and isolated OpenSSH new-host/password/changed-key behavior. Published Harbor 0.2 passed source/package CI for macOS Intel/ARM64, Windows x64 and Linux x64, plus 20 synthetic interface checks. Those results apply to historical source/packages. Fresh TermForge 0.3 native CI/package/interactive evidence remains pending. Real SFTP, key/agent/jump/forwarding, physical serial and LAN-device interoperability still require integration coverage. A generated installer does not verify every workflow.

TermForge 0.3 is unreleased; historical v0.2 downloads remain separately available. Packaging is configured for macOS ad-hoc signatures without Developer ID/notarization; Windows publisher signing is not established. Automatic updates and a maintenance service are not included. Source/test and distribution provenance must be verified for each new release.

## Ownership and attribution

TermForge's original source is MIT licensed. Dependencies retain their respective licenses and authorship, including Electron, node-pty, serialport, xterm.js and OpenSSH. Preserve required notices in redistributed builds. SecureCRT and VanDyke Software are VanDyke's trademarks; references identify the requested comparison or import format. There is no affiliation or endorsement.
