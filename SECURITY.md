# Security

Harbor Terminal is an initial release. It has not received an independent security audit and has no established support or security-update service.

## Security boundary

- The terminal is capable of running commands with your user account's permissions. Local programs, remote shells, pasted text, and snippets should receive the same scrutiny as commands in another terminal.
- SSH encryption, server host-key checks, authentication, and key storage are handled by the installed OpenSSH client. Harbor does not implement its own cryptography or credential vault.
- Unknown host keys are presented by OpenSSH in the terminal. Check the fingerprint before accepting it. Changed host keys should fail the connection; investigate the change rather than disabling verification.
- Harbor passes `-F none` to ignore SSH configuration files, preventing inherited proxy or local commands and inherited options that weaken host-key verification. The ordinary `known_hosts` database, available SSH agent, system policies, and installed OpenSSH version still matter. Enter hosts, usernames, keys, and jump hosts explicitly in the session editor.
- Session files store connection metadata, private-key file paths, and snippets. They do not intentionally store passwords or private-key contents. Do not put secrets in snippets or metadata.
- Logging is opt-in. A log records terminal output, including any sensitive values displayed or echoed by a program. Configuration exports and logs are ordinary local files, not encrypted backups.
- Harbor requests loopback-bound port forwarding. Close the session when finished. Remote SSH-server policy can reject a forwarding request or change the remote listener's binding behavior; verify the listener before relying on its exposure boundary.
- Sending a command to several live terminals can modify several systems. Review the command and the listed target sessions before confirming.

## Electron and dependencies

The renderer receives a constrained preload API; privileged terminal and file operations belong in the main process. Keep context isolation enabled, Node integration disabled in the renderer, local content protected by a content-security policy, and external navigation blocked. Do not extend the preload bridge into a generic command, filesystem, or IPC interface.

Keep Electron and dependencies current, preserve the lockfile, and investigate dependency advisories. Source-level tests do not prove resistance to every terminal escape sequence or hostile remote output. Changes to IPC, PTY lifecycle, imports, host validation, logs, and external links require particular care.

## Report a vulnerability

This source package does not yet have a published private reporting endpoint. Contact the maintainer or person who supplied the repository to arrange a private channel. If the repository is later hosted with private vulnerability reporting enabled, use that channel.

Include the version, operating system, reproduction steps, and expected impact. Use a local test host and synthetic data. Do not include real credentials, keys, account configuration, or production logs. Avoid publishing exploit details before the maintainer has had a chance to evaluate them.
