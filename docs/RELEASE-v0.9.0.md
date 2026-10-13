TermForge 0.9.0 adds OS-protected saved credentials, a fuller Quick Connect workflow and a graphical SFTP/SCP file-transfer workspace. It remains free, open source and MIT-licensed on macOS, Windows and Linux.

## Saved credentials and server trust

- Create or replace named username/password entries from **Transfer → Credentials**. Session profiles reference the entry, so a replacement applies to all linked sessions.
- Usernames/passwords and credential host grants are encrypted using macOS Keychain, Windows DPAPI or an available Linux libsecret/KWallet backend. TermForge refuses insecure Linux `basic_text` or unavailable storage. Names remain visible metadata; passwords have no reveal/read API.
- Managed SSH verifies the host fingerprint before accessing saved credentials or private keys. Changed keys block the connection. First use of a credential with a host/port/key requires native approval.
- Authentication responses bypass terminal writes, recordings, command history and AI context. Keyboard-interactive challenges always ask for fresh responses.
- JSON import/export clears local vault references and does not include the vault. Encrypted vault portability, a separate app lock/master password, key generation and proprietary credential import are not included.

## Quick Connect and file transfer

- Choose username or saved credentials, enable/reorder supported authentication methods, select a private key, open an SFTP workspace, save a session or optionally show Quick Connect at startup.
- Browse local and remote folders side by side; upload/download regular files with progress, a transfer queue, cancellation and overwrite review.
- SFTP handles normal copies. SCP performs actual `scp -f`/`scp -t` payload transfers; it still needs SFTP for browsing, metadata checks, staging and commit, and a compatible remote SCP program.
- Transfers stage new data and preserve recovery files on conflicting replacements. Remote metadata has limited timestamp precision and depends on the server honoring no-overwrite SFTP rename; avoid competing writers.

Managed SSH supports password, keyboard-interactive, explicit private keys (including passphrase prompts) and a bounded system SSH agent. Existing system OpenSSH sessions remain available for jump hosts, forwarding, certificates, GSSAPI and X11. Those advanced options are explicitly rejected by the managed transport. Host-key stores are separate. Opening file transfer creates a separate SSH connection using the profile/credential; it does not reuse the live terminal's channel.

This is a preview, not full SecureCRT/SecureFX parity. Recursive folder copying, resume, synchronization, remote editing, permission/time preservation and SCP-only servers are not supported. The project editor, reviewed Ansible workflow, optional free AI, color schemes and existing terminal tools remain available.

## Verification and platform notes

Local source passed 250 backend tests, 97 existing interface checks, 20 new secure-connection interface checks and 13 project-editor checks. Production dependency audit reported zero vulnerabilities. Tests use temporary files, synthetic credentials, injected OS-storage providers, headless UI fixtures and real loopback SSH/SFTP/SCP servers. Provider-injected vault tests do not verify native Keychain/DPAPI/keyring access. Cross-platform CI and installer verification remain pending. No Electron window is launched on the development laptop; native Electron smoke runs under Linux CI.

macOS packages retain ad-hoc signing without Apple notarization; Keychain may ask for access again after an update. Windows packages are unsigned. OS encryption protects storage according to each platform's guarantees; it is not a defense against a compromised unlocked account. System OpenSSH is needed only for the OpenSSH/interactive SFTP engine; the managed SSH/SFTP client is bundled. Python, Ansible and local AI runtimes remain separate installations.

Read the [credential and transfer guide](https://github.com/distractedagain/termforge/blob/main/docs/SECURE-CONNECTIONS.md) for use and security limits. Build records and `SHA256SUMS.txt` accompany published installers.
