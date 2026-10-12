# Security

TermForge is in early development. Version 0.3 is a published preview; version 0.4 is being prepared. It has not received an independent security audit and has no established support or security-update service. Each release has its own verification limits.

## macOS preview approval

The macOS preview uses an ad-hoc signature, without Apple Developer ID signing or notarization. A warning that Apple cannot verify the developer or check the app for malware is therefore expected. Windows preview packages are unsigned.

For a trusted release copy, use the app-specific **Open Anyway** exception described in [the README](README.md#opening-the-macos-preview) and [Apple's official instructions](https://support.apple.com/en-us/102445). A warning that software will damage your computer is a different condition.

## Security boundary

- The terminal is capable of running commands with your user account's permissions. Local programs, remote shells, pasted text, and snippets should receive the same scrutiny as commands in another terminal.
- SSH encryption, server host-key checks, authentication, and key storage are handled by the installed OpenSSH client. TermForge does not implement its own cryptography or credential vault.
- Unknown host keys are presented by OpenSSH in the terminal. Check the fingerprint before accepting it. Changed host keys should fail the connection; investigate the change rather than disabling verification.
- TermForge passes `-F none` to ignore SSH configuration files, preventing inherited proxy or local commands and inherited options that weaken host-key verification. The ordinary `known_hosts` database, available SSH agent, system policies, and installed OpenSSH version still matter. Enter hosts, usernames, keys, and jump hosts explicitly in the session editor.
- Session files store connection metadata, private-key file paths, and snippets. They do not intentionally store passwords or private-key contents. Do not put secrets in snippets or metadata.
- Logging is opt-in. A log records terminal output, including any sensitive values displayed or echoed by a program. Configuration exports and logs are ordinary local files, not encrypted backups.
- TermForge requests loopback-bound port forwarding. Close the session when finished. Remote SSH-server policy can reject a forwarding request or change the remote listener's binding behavior; verify the listener before relying on its exposure boundary.
- Sending a command to several live terminals can modify several systems. Review the command and the listed target sessions before confirming.
- Telnet, Raw TCP and TFTP do not encrypt traffic or provide SSH host-key authentication. TFTP starts explicitly with a selected root, one allowed client IP, and loopback port 6969 by default; uploads create new files only. Its IP filter is not cryptographic authentication. Do not expose unrelated files in its shared folder. See [TFTP limits](docs/TFTP.md).
- Python scripts run as local programs with your user privileges; they are not sandboxed. Cancellation owns the interpreter, not independently detached children. Run trusted scripts and read [the automation limits](docs/PYTHON-AUTOMATION.md). A script's `Session.Connected` reflects terminal availability and does not prove SSH authentication.
- Input recording is explicit and may capture passwords or other sensitive commands typed while active. Review and remove sensitive events before exporting or replaying generated Python. Command history and recordings are ordinary local data, not an encrypted vault.

## Electron and dependencies

The renderer receives a constrained preload API; privileged terminal and file operations belong in the main process. Keep context isolation enabled, Node integration disabled in the renderer, local content protected by a content-security policy, and external navigation blocked. Do not extend the preload bridge into a generic command, filesystem, or IPC interface.

Keep Electron and dependencies current, preserve the lockfile, and investigate dependency advisories. Source-level tests do not prove resistance to every terminal escape sequence or hostile remote output. Changes to IPC, PTY/device/socket lifecycle, imports, host validation, scripting, file serving, logs, and external links require particular care.

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/distractedagain/termforge/security/advisories/new) to contact the maintainers privately. Private reporting is enabled for this public repository. Report ordinary bugs through Issues, without including credentials or sensitive logs.

Include the version, operating system, reproduction steps, and expected impact. Use a local test host and synthetic data. Do not include real credentials, keys, account configuration, or production logs. Avoid publishing exploit details before the maintainer has had a chance to evaluate them.
