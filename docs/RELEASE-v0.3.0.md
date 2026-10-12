TermForge 0.3.0 is a public preview of a free, MIT-licensed terminal client for macOS, Windows, and Linux. The project was previously named Harbor Terminal. Existing Harbor configuration folders and the `HARBOR_DATA_DIR` override remain supported.

This version develops the SecureCRT 9.7 macOS layout with a compact toolbar, Connect/Keyword fields, vertical Session/Command/Active manager selectors, categorized options, a Command Window, named Button Bars, and a segmented status bar. Windows and Linux use in-window menus. TermForge remains an original implementation; it is not yet near identical or feature complete.

## Added in this preview

- Native Telnet and Raw TCP transports, serial port enumeration/settings, and terminal Break.
- Per-session terminal and SSH options, editable mapped keys, literal keyword highlighting, nested commands, command history, selected-field bulk editing, and saved session-set snapshots.
- Installed Python execution with a documented subset of send/wait/read, tab/session and actual screen-reading methods; cancellation and script output; optional input recording with review and Python export.
- Reviewed ASCII file sends, pause/resume output logging, and an explicitly started octet TFTP server restricted to one selected folder and client IP.
- TermForge branding and packaging, existing-profile preservation, atomic private exports, terminal-order synchronization for scripts, and shutdown that waits for owned resources.

SSH, interactive SFTP and local shells continue to use installed system tools. SSH password and private-key contents are not saved in session profiles.

## Downloads

| System | Package |
| --- | --- |
| macOS, Apple Silicon (ARM64) | macOS ARM64 DMG or ZIP |
| macOS, Intel | macOS x64 DMG or ZIP |
| Windows x64 | Setup installer or portable EXE |
| Linux x64 | AppImage or DEB |

Install `ssh` and `sftp` for those protocols; Windows may require enabling OpenSSH Client. Python automation requires an installed Python 3 interpreter (`python3` on macOS/Linux, `python` on Windows). Python is not bundled.

macOS packages have ad-hoc signatures and are not Apple notarized. Windows packages are unsigned. Operating systems may require explicit approval to open these preview builds. Linux AppImages require executable permission.

## Verification and limits

The local macOS Intel backend suite passed 84 tests. It used real TCP/UDP loopback sockets and real Python interpreters with controlled terminal callbacks; serial coverage used injected adapters and SerialPortMock, without physical hardware. The interface passed 46 headless Chromium checks using a synthetic bridge, with no console errors. These checks do not launch the Electron desktop app or establish real device interoperability.

The release publisher requires successful native test/build/package jobs for macOS ARM64, macOS Intel, Windows x64 and Linux x64 at the exact tagged source commit. It verifies every artifact's provenance and checksums before publishing. Windows may skip POSIX-specific tests. macOS packages additionally pass strict recursive ad-hoc signature verification. The four `BUILD_INFO` files record the source commit and verification limits; `SHA256SUMS.txt` covers the packages and provenance files.

Interactive runtime testing of this version's packaged desktop app remains pending. Real SFTP transfers, SSH key/agent/jump/forwarding, physical serial ports and LAN-device interoperability need additional integration tests. Earlier Harbor checks do not certify this version.

The [feature ledger](https://github.com/distractedagain/termforge/blob/main/docs/SECURECRT-PARITY.md) tracks remaining work: specialized legacy terminal emulations, SSH1/RLogin/Telnet TLS, complete credential/key/host-key and proxy managers, modem transfer protocols, graphical SFTP browsing, printing, full Python compatibility, independent tab groups/multiple windows, and applicable Windows-only capabilities are still incomplete or missing. The supported Python method subset does not establish compatibility with every SecureCRT script.

Telnet, Raw TCP and TFTP are unencrypted. Python scripts run with your local user's permissions. Recording can capture sensitive input; inspect recordings before saving or replaying them. TFTP starts only explicitly, defaults to loopback port 6969, permits one client IP, rejects linked paths and creates new uploads without overwriting existing files.

TermForge is independent of VanDyke Software. No proprietary SecureCRT code, disassembly or copied artwork is included. Dependencies keep their original licenses and notices.

Report ordinary bugs in Issues and sensitive security findings through the repository's private vulnerability reporting channel. Remove credentials and sensitive host information from reports.
