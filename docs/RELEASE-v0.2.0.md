Harbor Terminal 0.2.0 is the first public preview of a free, MIT-licensed desktop SSH and SFTP client with a classic terminal-client interface.

It includes saved sessions and nested folders, tabs and tiled terminals, a Command Window and Button Bar, terminal search, opt-in output logging, SSH identity files/jump hosts/port forwarding, interactive SFTP, and nonsecret SecureCRT SSH2 session import. It uses the system OpenSSH client and does not store passwords or private-key contents.

## Downloads

Choose the package matching your operating system and processor:

| System | Package |
| --- | --- |
| macOS, Apple Silicon (ARM64) | macOS ARM64 DMG or ZIP |
| macOS, Intel | macOS x64 DMG or ZIP |
| Windows x64 | Setup installer or portable EXE |
| Linux x64 | AppImage or DEB |

The `ssh` and `sftp` commands must be installed for remote connections. Windows users may need to enable the OpenSSH Client optional feature. Local shells do not require OpenSSH.

macOS builds use ad-hoc signatures and are not Apple notarized. Windows builds are unsigned. Your operating system may require explicit approval before opening these preview builds. Linux AppImages need executable permission after download.

## Verification and limits

The release files are built from the tagged source by the repository's native-platform GitHub Actions workflow. Backend unit tests, renderer builds, and packaging checks passed on those runners. macOS packages additionally passed strict recursive signature checks. `BUILD_INFO` files record the commit and verification boundary; `SHA256SUMS.txt` records the release asset hashes.

The 0.2 interface passed 20 headless browser checks using synthetic sessions. Earlier local macOS Intel checks exercised real local PTYs and real OpenSSH against an isolated loopback server, including host-key refusal. These results do not constitute an independent security audit or complete interactive runtime testing on every platform. SFTP transfers, key/agent authentication, jump hosts, and forwarding still need broader integration testing.

This is an early preview. Serial/Telnet, a graphical SFTP file browser, and a full scripting engine are not included. No affiliation with VanDyke Software is implied, and no proprietary SecureCRT code or visual assets are included.

Report ordinary bugs in Issues and sensitive security findings through the repository's private vulnerability reporting channel. Please remove credentials and sensitive host information from reports.
