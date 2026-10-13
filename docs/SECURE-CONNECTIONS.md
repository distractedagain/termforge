# Saved credentials and file transfers

TermForge 0.9 adds named credentials, managed SSH connections, and a graphical file-transfer workspace. These are independent implementations using Electron's OS storage APIs and the open-source ssh2 library. They do not import SecureCRT's encrypted passwords or require SecureFX.

## Quick Connect

Open **File → Quick Connect**. For SSH2, choose the managed connection engine, enter the hostname and port, and choose either a username with authentication prompts or a saved credential. Enable and reorder Public key, Keyboard interactive and Password methods. An explicit private-key path or the system agent supplies public keys; encrypted keys prompt for a passphrase. Keyboard-interactive challenges always ask for fresh answers, including when a password is saved.

Managed SSH discovers an agent through `SSH_AUTH_SOCK` in TermForge's environment. It does not automatically discover a Windows OpenSSH agent or Pageant. Configure the appropriate agent endpoint before launching TermForge, or choose an explicit private-key file.

**SFTP session** opens File Transfer. **Save session** stores the connection profile. **Show Quick Connect on startup** opens the form at launch without connecting. Terminal connections open in tabs; detached windows are not implemented.

The screenshot's firewall/GSSAPI controls map to a separate **System OpenSSH** engine: its existing session options support one jump host, forwarding and GSSAPI according to the installed client/server. Managed SSH currently rejects jump hosts, forwarding, SSH certificates, GSSAPI and X11 forwarding. Choose the OpenSSH engine for those terminal workflows; saved TermForge passwords cannot be used with it. A control being visible does not mean every SecureCRT authentication or firewall configuration is supported.

## Credential manager

Open **Tools → Manage Saved Credentials**. Give the credential a descriptive name, username and password. Create or replace requires entering both secret fields; stored passwords are never revealed in the UI. Saved profiles retain a credential identifier instead of a username/password. Deleting a credential leaves any dependent profiles in place so they can be assigned a new credential.

The vault encrypts username, password and approved-host grants in the main process, in `credentials.json` within the application data directory. Names, IDs and update dates are visible metadata. Session JSON, exports, terminal input history and AI attachments do not receive the decrypted vault payload. Both JSON import and export clear credential references; assign a local credential after import. The vault is not a portable or recoverable encrypted backup.

On macOS the encryption key is protected by Keychain; on Windows by DPAPI for the current user. Linux requires an available GNOME libsecret or KWallet backend. TermForge refuses to save or decrypt using Electron's `basic_text`, unknown or unavailable backend. A connection can still prompt for a password without saving it. Linux uses the inspectable synchronous backend because the asynchronous provider has separate fallback behavior. macOS and Windows use the asynchronous API.

These mechanisms protect stored data with the operating system's guarantees. They do not protect an unlocked, compromised account or prevent an authenticated remote server from seeing a password sent to it. DPAPI does not isolate secrets from other processes running as the same Windows user. The current macOS preview is ad-hoc signed; Keychain may ask for approval again after updates. TermForge has no separate master password, biometric unlock, app-level vault lock, password recovery, or encrypted vault export. See [Electron's platform-specific storage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).

## Server identity and credential approval

Managed SSH presents a native confirmation showing the server's SHA-256 host-key fingerprint before reading a stored credential or private key. Compare it with a fingerprint supplied independently by the server administrator. Acceptance pins the key for the host and port. A changed key blocks the connection. **Tools → Trusted SSH Hosts** lists the managed keys; forgetting a key requires confirmation and makes the next connection prompt again.

The first use of a saved credential with a hostname, port and verified key needs a separate native approval. Changing any of those requires a new approval. Replacing the credential clears those grants. This prevents an imported profile or another host from silently obtaining a saved password. Native host-key and credential approvals default to Cancel. Authentication prompts expire and are cleared on cancellation or disconnection.

Managed host keys are stored separately from system OpenSSH's `known_hosts`. OpenSSH sessions continue to use OpenSSH's host-key checks and agent. Opening File Transfer from an existing session starts a separately authenticated connection using the same profile and named credential; it does not take over the terminal's SSH channel.

## File Transfer

Use the transfer toolbar or **Transfer → SFTP / SCP File Transfer** with an SSH profile selected. The left pane browses local files; the right pane browses the server. Double-click directories, select regular files, then use Upload or Download. The queue shows progress, completion, errors and cancellation. File names are displayed as text.

Choose **SFTP** for normal transfers or **SCP** for actual `scp -t`/`scp -f` file payloads on the same verified SSH connection. SCP mode still requires SFTP for directory browsing, destination checks, staging and commit, and a compatible `scp` executable on the remote server. SCP-only servers are not supported. Both modes currently copy regular files, with multiple selected files queued individually. Directory recursion, symbolic-link copying, resume, synchronization, remote editing, drag and drop, and permission/time preservation are not included.

SCP commands use POSIX shell quoting and require a compatible remote SSH command shell. Use SFTP for Windows servers whose SSH command shell is `cmd.exe` or PowerShell. Windows-client SCP tests exercise the file protocol and quoting through an isolated server fixture; they do not establish compatibility with those Windows server shells.

Transfers use temporary files and ask before replacing an existing destination. Local downloads reject symlinks and unsafe remote file names. Failed/cancelled transfers try to remove their temporary files; a lost connection or app crash can leave a remote temporary file. Existing files are checked again before replacement. Conflicts can leave the prior destination in a named recovery file, reported in the transfer error. Remote checks use size/type/timestamps, so a same-size change within the timestamp resolution may be missed. Remote commits also depend on the server honoring SFTP v3's no-overwrite rename behavior. Avoid uploading over a file another process is actively updating.

The local destination filesystem must permit hard links, which TermForge uses to commit a download without silently overwriting a competing file. Filesystems without hard-link support, including FAT/exFAT volumes, cannot receive downloads. Before replacing an existing local file, TermForge checks this capability and leaves that file in place if the check fails. Choose another local folder or filesystem.

Cancellation stops queued jobs and active copying. Once replacement has begun, TermForge waits for its outcome: an acknowledged replacement reports Completed. If the server disconnects before acknowledging a rename, the job reports an uncertain outcome, retains available recovery files and stops that transfer connection. Inspect the named paths before retrying. Quitting with an active transfer connection requires confirmation and waits for owned cleanup.

## Remote file management

Version 0.13 adds **New folder**, **Rename**, **Delete** and **Permissions** above the remote listing. Select one regular file or directory for an existing-item action. Enter the new name or three-digit permissions, then click **Review**. The application inspects the target and shows its canonical path and server. The action button opens a separate native confirmation before any mutation.

New folders use mode 0700. Rename stays within the selected directory and requires a missing destination. Delete permanently removes one regular file or empty directory; it is not recursive and does not use a trash folder. Permissions accepts 000–777 and refuses files or directories with setuid, setgid or sticky bits. Symbolic links in the target or parent path, root/dot paths and special files are rejected. The review shows permissions from fresh server metadata.

Review tokens last 60 seconds and can be used only once. Pending operations block other transfers and file changes across this transfer manager, including separately opened connections that may address the same paths. Before committing, the backend rechecks parents and target metadata, including size, timestamp, owner/group and mode. Closing the connection invalidates the review. Native confirmation can be canceled; once the mutation is sent, the app waits for its bounded outcome.

SFTP v3 provides no conditional inode-based mutation. A different process can still replace a path after the final check, and equal metadata does not prove file identity. Standard rename also depends on the server honoring no-overwrite semantics. Avoid operations on paths being changed concurrently. A timeout or lost transport after sending a mutation is reported as **outcome unknown** and closes the connection; reconnect and inspect the named paths before trying again. There is no automatic retry or rollback.

## Verification scope

Automated coverage uses synthetic credentials, temporary folders, mocked OS-encryption providers and real loopback SSH/SFTP/SCP servers. This exercises application behavior without reading the developer's keychain or connecting to a production host. Provider-injected vault tests do not establish native Keychain/DPAPI/keyring behavior. Release notes record the completed platform and native IPC checks. Real appliances, every SSH authentication combination and interactive packaged-app behavior need separate interoperability testing.

The feature inventory is informed by the user's Quick Connect reference and public documentation for [SecureCRT/SecureFX credentials](https://www.vandyke.com/support/tips/how-to-manage-credentials-in-securecrt-securefx.html) and [SecureFX file transfer](https://www.vandyke.com/products/securefx/encrypted_file_transfer.html). Full product parity is still a development goal.
