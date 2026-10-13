# Feature map

TermForge is an independently written, MIT-licensed terminal client. It uses public feature descriptions and original code, not VanDyke source code, disassembly or artwork. SecureCRT 9.7 macOS is the visual reference; the overall feature goal covers every applicable capability on macOS, Windows and Linux. The [sourced parity ledger](SECURECRT-PARITY.md) tracks requirements and gaps without claiming complete equivalence.

## Current source scope — TermForge 0.6.1

| Workflow | TermForge implementation | Limits |
| --- | --- | --- |
| Desktop | Electron with native PTYs and socket/device adapters; versioned CI/package evidence below | Limited user-reported macOS launch/local-shell/SSH feedback; full packaged-app runtime coverage pending |
| AI Assistant | Local Ollama or OpenRouter free router, explicit editable context, streamed answers, reviewed commands pinned to the original terminal | Free online quotas apply; temporary user API key required online; no bundled ChatGPT/Claude API, autonomous execution, saved chat history or live model verification; see [AI guide](AI-ASSISTANT.md) |
| Terminal | xterm.js scrollback, selection, resize, search, per-session fonts/schemes/cursor | TERM hints do not create distinct VT/ANSI engines; specialized emulations remain missing |
| Local shell | Operating-system shell in node-pty | Uses the user's environment and permissions |
| SSH | Installed system OpenSSH | Installed client/server determine authentication and algorithm support; no authentication-state detector |
| SFTP / ASCII | Interactive system SFTP and reviewed ASCII text file send | No shared SSH transport, drag/drop transfer, graphical browser, receive ASCII or binary send |
| Telnet / Raw TCP | Original adapters; Telnet option/NAWS/terminal-type/echo handling and break | UTF-8 text stream; real loopback tests, no external-device interoperability coverage |
| Serial | Device enumeration, baud/data/stop/parity/flow options, streaming/break, asynchronous close/retry | Mock/injected adapter tests; no physical hardware/device interoperability verification or Hex View |
| Saved sessions | Nested inferred folders/filter, Quick Connect, Connect Bar, selected/folder connect and selected-field bulk edits | Up to 1,000 profiles; no explicit empty folders, complete bulk option catalog or default/auto session system |
| Workspace | Reorder/clone tabs, independent tab groups, resizable splits, horizontal/vertical/grid tiles, Active Sessions list | Up to 32 open terminals; no floating managers, live-tab multi-window movement or locking |
| Snapshots | Saved connection instances including repeats, group/tab order, per-group selection, focused group, split arrangement and ratios; restore beside existing tabs | Up to 32 saved connections; unsaved quick connections, terminal output and running process state excluded; current profile settings apply |
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

## Color schemes added in 0.4

| Workflow | Implementation | Limits |
| --- | --- | --- |
| Palette selection | Options → Color Schemes and palette toolbar button; seven named presets with ANSI samples | Custom palette editing/import is not included |
| Terminal palette | Sixteen normal/bright ANSI colors, foreground/background, cursor/accent, active/inactive selection | Programs with explicit RGB colors or their own themes may retain those colors |
| Global and session colors | Global default plus per-session override or inheritance; saved appearance changes update open matching terminals | Connection settings still take effect on the next connection |
| Matching interface | Optional toolbars, managers, tabs, dialogs and status colors based on the global default | Per-session palettes do not recolor the interface; operating-system UI remains system controlled |
| Preview and save | Local xterm sample, keyboard radio selection, Apply/Cancel/Escape, inline save errors | Preview opens no shell or connection; changes apply only after a successful save |

The presets are Traditional, Monochrome, Solarized Dark, Solarized Light, Forge Dark, Forge Light, and High Contrast. The Solarized variants follow [Ethan Schoonover's original sRGB palette and ANSI assignments](https://ethanschoonover.com/solarized/). Read [Color Schemes](COLOR-SCHEMES.md) for the controls, inheritance rules, and display limits.

## Remaining gaps

SSH1, RLogin, Telnet/TLS, Windows RDP/ActiveX/COM behavior, distinct TN3270/Wyse/TVI/SCO and other emulations, full credential/key/host-key management, advanced named proxies, X/Y/Zmodem/Kermit, printing, automatic logging/rotation, complete automation compatibility, and SecureFX integration remain missing or incomplete. The macOS layout choice does not remove applicable Windows/Linux capabilities from the overall goal.

The limited INI reader imports nonsecret SSH2 connection metadata, not passwords, authentication databases, scripts or complete settings. Review imported hosts, ports, usernames, folders and key paths before connecting; conservative validation may reject unusual values, and Windows key paths can require changes on another platform. SSH config aliases/proxy commands are not inherited.

JSON import adds sessions and assigns fresh IDs on collisions, remapping snapshot references. Included preferences, commands and history update their corresponding configuration. Both import paths validate before writing and do not connect automatically. Version-1 migration concerns file schema; it does not promise migration of every historical application data directory.

## Verification and distribution

The 0.6 development checks passed **156 backend tests and 91 headless interface checks**, with no failures or console errors. Local AI tests use real isolated HTTP fixtures; online tests simulate HTTPS/SSE. Interface tests exercise consent, exact selected-context sharing, temporary API-key clearing, clipboard focus, streaming/cancellation and reviewed commands pinned to their original terminal. These results do not establish live provider availability or packaged desktop behavior.

The 0.5 update passed **115 local backend tests and 72 headless interface checks**, without failures or browser console errors. [Native CI](https://github.com/distractedagain/termforge/actions/runs/38328313996), [packaging](https://github.com/distractedagain/termforge/actions/runs/38328332260), and [publication](https://github.com/distractedagain/termforge/actions/runs/38328921919) succeeded on the first attempt at tagged source `a3697bcbb7c803edfde80d23e5c5769c621671ba`. Both Macs and Linux passed 115 tests each; Windows passed 112 with three expected POSIX-only skips. Linux passed 72 headless checks. All thirteen public assets matched the manifest and asset digests; anonymously downloaded build records confirmed the tagged source. These checks cover source/build provenance and synthetic renderer behavior, with packaged interactive testing still pending.

On October 12, 2026, the 0.3 feature batch passed **84 local backend tests and 46 headless renderer checks**, with zero failures and no browser console errors. Transport/TFTP tests use real TCP/UDP loopback sockets. Python tests launch an actual interpreter with controlled session/screen callbacks. Serial tests use injected adapters and the installed mock binding. Headless checks use a synthetic bridge and actual validators/code generation; they do not launch Electron or perform real remote connections, scripts or transfers.

[Native CI](https://github.com/distractedagain/termforge/actions/runs/38320236458) and [packaging](https://github.com/distractedagain/termforge/actions/runs/38320240854) succeeded at released commit `09abaaefbb440d0600647ac389e32f72dca98700`: both Macs and Linux passed 84 tests each; Windows passed 81 and skipped three POSIX-specific checks. Linux passed 46 headless interface checks, and both Mac packages passed strict recursive ad-hoc signature checks. The [publisher](https://github.com/distractedagain/termforge/actions/runs/38320923229) verified eight packages and four build records before public release; the public manifest and build records were independently downloaded and checked against GitHub asset digests.

A user reported successful launch, local-shell use, and an SSH connection in the installed v0.3 macOS app. This limited manual evidence does not establish a complete native runtime test matrix. Real SFTP, key/agent/jump/forwarding, physical serial and LAN-device interoperability still require integration coverage. Historical Harbor 0.1 macOS Intel checks established real local PTYs and isolated OpenSSH new-host/password/changed-key behavior; Harbor 0.2 passed source/package CI and 20 synthetic interface checks. Those results apply to historical source/packages. A generated installer does not verify every workflow.

The 0.4 source passed **92 backend tests and 63 headless renderer checks**, with no failures or browser console errors. Coverage includes complete palette definitions, strict saved-setting validation, inheritance and persistence, real xterm previews, cancellation and asynchronous save handling, interface matching, and live terminal updates. Headless renderer coverage uses a synthetic application bridge and does not prove packaged native rendering or live remote interoperability.

For v0.4, [native CI](https://github.com/distractedagain/termforge/actions/runs/38324020057) and [packaging](https://github.com/distractedagain/termforge/actions/runs/38324019614) succeeded at tagged commit `0e9ae540293fac90d0c31649705fed6fdb2f2df3`: both Macs and Linux passed 92 backend tests each; Windows passed 89 with three POSIX-only skips. Linux passed 63 headless checks, and both Mac packages passed strict recursive ad-hoc signature verification. Windows packaging passed on its second attempt at unchanged source after Python-initialization and UDP-fixture timeouts. The [publisher](https://github.com/distractedagain/termforge/actions/runs/38325248387) validated all thirteen assets; anonymously downloaded checksums and build records matched the asset digests and tagged source.

[TermForge v0.5.0 preview downloads](https://github.com/distractedagain/termforge/releases/tag/v0.5.0) are public; earlier previews remain separately available. macOS packages have ad-hoc signatures without Developer ID/notarization; Windows packages are unsigned. Automatic updates and a maintenance service are not included. Source/test and distribution provenance must be verified for each new release.

## Ownership and attribution

TermForge's original source is MIT licensed. Dependencies retain their respective licenses and authorship, including Electron, node-pty, serialport, xterm.js and OpenSSH. Preserve required notices in redistributed builds. SecureCRT and VanDyke Software are VanDyke's trademarks; references identify the requested comparison or import format. There is no affiliation or endorsement.
