# Security

ForgeCRT is in early development. See the README for the current published preview. It has not received an independent security audit and has no established support or security-update service. Each release has its own verification limits.

## macOS preview approval

The macOS preview uses an ad-hoc signature, without Apple Developer ID signing or notarization. A warning that Apple cannot verify the developer or check the app for malware is therefore expected. Windows preview packages are unsigned.

For a trusted release copy, use the app-specific **Open Anyway** exception described in [the README](README.md#opening-the-macos-preview) and [Apple's official instructions](https://support.apple.com/en-us/102445). A warning that software will damage your computer is a different condition.

## Security boundary

- The terminal is capable of running commands with your user account's permissions. Local programs, remote shells, pasted text, and snippets should receive the same scrutiny as commands in another terminal.
- Managed SSH/file transfer uses ssh2, a separate pinned host-key database, native first-use confirmation, and fail-closed changed-key checks. System OpenSSH sessions keep the installed client's encryption, authentication, agent and host-key checks. Check fingerprints before accepting them.
- The named credential vault encrypts usernames/passwords with OS-protected keys. macOS/Windows use asynchronous Keychain/DPAPI APIs; Linux uses the inspectable libsecret/KWallet backend and refuses `basic_text` or unavailable storage. Native approval binds credential use to hostname, port and verified fingerprint. Names are plaintext metadata, and same-user OS protection varies. See [vault guarantees and limitations](docs/SECURE-CONNECTIONS.md).
- ForgeCRT passes `-F none` to ignore SSH configuration files, preventing inherited proxy or local commands and inherited options that weaken host-key verification. The ordinary `known_hosts` database, available SSH agent, system policies, and installed OpenSSH version still matter. Enter hosts, usernames, keys, and jump hosts explicitly in the session editor.
- Session files store connection metadata, private-key paths, credential references and snippets. They do not store passwords or private-key contents; profiles using vault credentials omit usernames. Imports/exports clear vault references and exclude the separate vault. Do not put secrets in snippets or metadata.
- Graphical transfers stage regular files and explicitly confirm replacement; local symlinks/unsafe names are rejected. Remote checks cannot provide a portable atomic compare-and-replace guarantee against other writers. A lost connection can leave a remote temporary file. SCP payloads require the server's SCP executable and the workspace still needs SFTP for browsing/staging.
- Logging is opt-in. A log records terminal output, including any sensitive values displayed or echoed by a program. Configuration exports and logs are ordinary local files, not encrypted backups.
- ForgeCRT requests loopback-bound port forwarding. Close the session when finished. Remote SSH-server policy can reject a forwarding request or change the remote listener's binding behavior; verify the listener before relying on its exposure boundary.
- Sending a command to several live terminals can modify several systems. Review the command and the listed target sessions before confirming.
- Telnet, Raw TCP and TFTP do not encrypt traffic or provide SSH host-key authentication. TFTP starts explicitly with a selected root, one allowed client IP, and loopback port 6969 by default; uploads create new files only. Its IP filter is not cryptographic authentication. Do not expose unrelated files in its shared folder. See [TFTP limits](docs/TFTP.md).
- Python scripts run as local programs with your user privileges; they are not sandboxed. Cancellation owns the interpreter, not independently detached children. Run trusted scripts and read [the automation limits](docs/PYTHON-AUTOMATION.md). A script's `Session.Connected` reflects terminal availability and does not prove SSH authentication.
- Input recording is explicit and may capture passwords or other sensitive commands typed while active. Review and remove sensitive events before exporting or replaying generated Python. Command history and recordings are ordinary local data, not an encrypted vault.

## Electron and dependencies

The optional AI Assistant sends only the typed prompt and explicitly attached, editable context. Common secret masking is incomplete; review the preview. Online requests require explicit opt-in and send text to OpenRouter and its model provider, whose retention policies apply. API keys are temporary and are not saved to settings or exports. Local mode uses a fixed loopback Ollama endpoint and verifies local-model metadata before sending prompts. AI replies are untrusted text; command suggestions are staged, pinned to their original session and confirmed before execution. There is no autonomous terminal or filesystem tool access. See [AI privacy and limits](docs/AI-ASSISTANT.md).

The renderer receives a constrained preload API; privileged terminal and file operations belong in the main process. Keep context isolation enabled, Node integration disabled in the renderer, local content protected by a content-security policy, and external navigation blocked. Do not extend the preload bridge into a generic command, filesystem, or IPC interface.

Keep Electron and dependencies current, preserve the lockfile, and investigate dependency advisories. Source-level tests do not prove resistance to every terminal escape sequence or hostile remote output. Changes to IPC, PTY/device/socket lifecycle, imports, host validation, scripting, file serving, logs, and external links require particular care.

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/distractedagain/termforge/security/advisories/new) to contact the maintainers privately. Private reporting is enabled for this public repository. Report ordinary bugs through Issues, without including credentials or sensitive logs.

Include the version, operating system, reproduction steps, and expected impact. Use a local test host and synthetic data. Do not include real credentials, keys, account configuration, or production logs. Avoid publishing exploit details before the maintainer has had a chance to evaluate them.

## Transfer recovery and remote drafts

Resumable SFTP files retain bounded, private application-data checkpoints containing paths, endpoint metadata and hashes, with no passwords, private keys or file contents. Actual partial contents remain in the destination folder. Resume requires a new explicit approval and the same authenticated server key/account, checks the source and retained bytes, and refuses changed targets. Invalid recovery data disables file-transfer mutation instead of starting unverified recovery. Unknown commit results require inspection; discarding such a record does not delete uncertain server files.

Merge and one-way synchronization previews are single-use, expire and revalidate before mutation. They never delete destination-only entries. Completed children remain after cancellation or failure. Remote text drafts are memory-only, size-bounded and saved only after revision review and native confirmation; they are not protected against application crashes. SFTP v3 metadata and path checks reduce, but cannot eliminate, races with other server processes.


## FTP recovery and saved synchronization

FTP/FTPS file and folder checkpoints use a separate private recovery directory and store no passwords or file contents. Resume verifies source/partial/completed-file content and binds the account, endpoint and protocol; FTPS also binds its validated certificate. Plain FTP remains unencrypted and provides no cryptographic server identity. Unsupported resume operations fail without silent restart. Forgetting an FTP journal preserves output, staging files and backups; unknown commit outcomes require inspection.

Persistent SFTP synchronization stores common content fingerprints and exact folder/account/server-key bindings in private versioned storage. Explicit reviews include every planned permanent deletion. A revision check and exclusive storage lease prevent stale or concurrent baseline writes; failed/partial runs keep the old baseline. Skipped conflicts retain their previous ancestor. Crash-left locks require inspection of the trees, baseline and stopped process before manual removal. These protections do not make folder mutations atomic or provide rollback, scheduling or protection from a compromised local account.
