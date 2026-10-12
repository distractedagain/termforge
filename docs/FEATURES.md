# Feature map

Harbor Terminal was built from standard terminal-client workflows and publicly documented feature descriptions, not from VanDyke source code or binary analysis. The reference pages consulted on October 12, 2026 were [SecureCRT overview](https://www.vandyke.com/products/securecrt/) and [SecureCRT key features](https://www.vandyke.com/products/securecrt/key_features.html). Their public descriptions include session management, tabs/tiles, SSH access, command reuse, and scripting. Harbor implements the subset below with its own interface and code.

## First-version scope

| Workflow | Harbor implementation | Limits |
| --- | --- | --- |
| Desktop application | Electron application with native PTYs | Targets macOS, Windows, and Linux; native Windows/Linux runtime testing still pending |
| Terminal emulation | xterm.js with scrollback, selection, resize, and search | No claim of full compatibility with SecureCRT's emulation families or key mappings |
| Local terminal | Operating-system shell in node-pty | Uses the user's shell environment and permissions |
| Remote terminal | System `ssh` client | Requires OpenSSH on PATH; installed client and server determine supported authentication |
| File transfer | Interactive system `sftp` terminal | Command-based transfer, with no graphical remote file browser |
| Saved sessions | Named connections, nested folder tree, and filtering | Single-click selects; double-click or Connect opens; at most 1,000 saved sessions; no saved-password vault |
| Multiple sessions | Tabs and tiled terminal layout | At most 32 open terminals; no SecureCRT workspace or script compatibility claim |
| Reusable commands | Named snippets with preview | No full scripting engine, recording, or SecureCRT object API |
| Multi-session input | Explicit broadcast with confirmation | Commands execute on the selected live terminals using their current shell state |
| Output capture | Opt-in raw terminal output logging to a new file | Stops at 128 MiB; ANSI escape sequences and sensitive output can be included |
| Appearance | Classic menus/toolbars, resizable docked panels, Command Window, Button Bar, status bar, themes and fonts | Original controls and icons arranged around familiar SecureCRT workflows |
| SSH authentication | Identity-file path and existing SSH agent | Key material is handled by OpenSSH; password prompts remain in terminal; SSH config files are ignored |
| Jump hosts | One explicit OpenSSH jump host | OpenSSH compatibility and server access are required; no comma-separated chain of hops |
| Tunneling | Local, remote, and dynamic forwarding requested on loopback | Server policy can reject forwarding or alter remote binding; no automated network-policy configuration |
| Portable configuration | Harbor JSON import/export | Exports may reveal infrastructure metadata and snippets |
| Session migration | Selected nonsecret fields from plain SSH2 SecureCRT INI files | Best effort; no passwords, vault recovery, scripts, or full configuration conversion |

## Not implemented

SSH1, Telnet/Telnet-TLS, serial ports, RDP, TN3270 and other specialized terminal emulations, a graphical SFTP browser, X/Y/Zmodem, Kermit, a TFTP server, credential vaults, Python/ActiveX scripting, script recording, and SecureFX integration are not included.

Migration accepts a limited plain session-file format. It does not decrypt stored secrets or import proprietary authentication databases. Review every imported host, port, username, folder, and identity path before connecting. Windows identity paths may need adjustment on macOS or Linux. Conservative host and username validation can reject unusual names; saved connections do not inherit SSH config aliases, proxy commands, or authentication options.

Harbor JSON import adds the supplied sessions, giving colliding session IDs fresh IDs. If the file includes preferences or snippets, those lists replace the existing values. The SecureCRT importer adds sessions while retaining Harbor preferences and snippets. Both validate before committing the import and do not connect automatically.

## Verification and distribution

On October 12, 2026, version 0.1 macOS x64 verification passed all 16 backend tests and desktop checks for renderer isolation, profile persistence, real local PTYs, two tiled terminals, confirmation before two-target broadcast, preferences persistence, and terminal search. An isolated loopback server exercised the real system SSH client through new-host confirmation, password authentication, remote output, and changed-host-key refusal. Version 0.2 replaces the interface with classic desktop controls; its visual and interaction checks run in a headless browser with a synthetic bridge, without relaunching Electron. Those checks do not represent additional live connections.

Windows and Linux have launch-contract tests and native-platform CI/build definitions, but their native applications have not been run in this workspace. Real SFTP transfers, key/agent authentication, jump hosts, and forwarding have not received integration tests. The GitHub workflows still have to run in the eventual repository before their results can be claimed. A generated installer is not evidence that every protocol, authentication method, or target-platform shell has been exercised.

The first distribution is a source package and local build. Code signing, notarization, public hosting, automatic updates, and a maintenance service are not established by this package. Add native interactive tests and signing before distributing production releases broadly.

## Ownership and attribution

Harbor's source is MIT licensed. Electron, node-pty, xterm.js, OpenSSH, and other dependencies retain their own licenses and authorship. Preserve their required notices in redistributed builds. SecureCRT and VanDyke Software are VanDyke's trademarks and are mentioned only to identify the requested comparison and import format. There is no affiliation or endorsement.
