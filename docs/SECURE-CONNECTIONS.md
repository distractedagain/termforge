# Saved credentials and file transfers

ForgeCRT provides named credentials, managed SSH connections, and a graphical file-transfer workspace. These are independent implementations using Electron's OS storage APIs and the open-source ssh2 library. They do not import SecureCRT's encrypted passwords or require SecureFX.

## Quick Connect

Open **File → Quick Connect**. For SSH2, choose the managed connection engine, enter the hostname and port, and choose either a username with authentication prompts or a saved credential. Enable and reorder Public key, Keyboard interactive and Password methods. An explicit private-key path or the system agent supplies public keys; encrypted keys prompt for a passphrase. Keyboard-interactive challenges always ask for fresh answers, including when a password is saved.

Managed SSH discovers an agent through `SSH_AUTH_SOCK` in ForgeCRT's environment. It does not automatically discover a Windows OpenSSH agent or Pageant. Configure the appropriate agent endpoint before launching ForgeCRT, or choose an explicit private-key file.

**SFTP session** opens File Transfer. **Save session** stores the connection profile. **Show Quick Connect on startup** opens the form at launch without connecting. Terminal connections open in tabs; detached windows are not implemented.

The screenshot's firewall/GSSAPI controls map to a separate **System OpenSSH** engine: its existing session options support one jump host, forwarding and GSSAPI according to the installed client/server. Managed SSH currently rejects jump hosts, forwarding, SSH certificates, GSSAPI and X11 forwarding. Choose the OpenSSH engine for those terminal workflows; saved ForgeCRT passwords cannot be used with it. A control being visible does not mean every SecureCRT authentication or firewall configuration is supported.

## Credential manager

Open **Tools → Manage Saved Credentials**. Give the credential a descriptive name, username and password. Create or replace requires entering both secret fields; stored passwords are never revealed in the UI. Saved profiles retain a credential identifier instead of a username/password. Deleting a credential leaves any dependent profiles in place so they can be assigned a new credential.

The vault encrypts username, password and approved-host grants in the main process, in `credentials.json` within the application data directory. Names, IDs and update dates are visible metadata. Session JSON, exports, terminal input history and AI attachments do not receive the decrypted vault payload. Both JSON import and export clear credential references; assign a local credential after import. The vault is not a portable or recoverable encrypted backup.

On macOS the encryption key is protected by Keychain; on Windows by DPAPI for the current user. Linux requires an available GNOME libsecret or KWallet backend. ForgeCRT refuses to save or decrypt using Electron's `basic_text`, unknown or unavailable backend. A connection can still prompt for a password without saving it. Linux uses the inspectable synchronous backend because the asynchronous provider has separate fallback behavior. macOS and Windows use the asynchronous API.

These mechanisms protect stored data with the operating system's guarantees. They do not protect an unlocked, compromised account or prevent an authenticated remote server from seeing a password sent to it. DPAPI does not isolate secrets from other processes running as the same Windows user. The current macOS preview is ad-hoc signed; Keychain may ask for approval again after updates. ForgeCRT has no separate master password, biometric unlock, app-level vault lock, password recovery, or encrypted vault export. See [Electron's platform-specific storage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).

## Server identity and credential approval

Managed SSH presents a native confirmation showing the server's SHA-256 host-key fingerprint before reading a stored credential or private key. Compare it with a fingerprint supplied independently by the server administrator. Acceptance pins the key for the host and port. A changed key blocks the connection. **Tools → Trusted SSH Hosts** lists the managed keys; forgetting a key requires confirmation and makes the next connection prompt again.

The first use of a saved credential with a hostname, port and verified key needs a separate native approval. Changing any of those requires a new approval. Replacing the credential clears those grants. This prevents an imported profile or another host from silently obtaining a saved password. Native host-key and credential approvals default to Cancel. Authentication prompts expire and are cleared on cancellation or disconnection.

Managed host keys are stored separately from system OpenSSH's `known_hosts`. OpenSSH sessions continue to use OpenSSH's host-key checks and agent. Opening File Transfer from an existing session starts a separately authenticated connection using the same profile and named credential; it does not take over the terminal's SSH channel.

## File Transfer

Use the transfer toolbar or **Transfer → SFTP / SCP File Transfer** with an SSH profile selected. The left pane browses local files; the right pane browses the server. Double-click directories to browse. Select regular files, or one folder in SFTP mode, then use Upload or Download. The queue shows progress, completion, errors and cancellation. File names are displayed as text.

Choose **SFTP** for normal transfers or **SCP** for actual `scp -t`/`scp -f` file payloads on the same verified SSH connection. SCP mode still requires SFTP for directory browsing, destination checks, staging and commit, and a compatible `scp` executable on the remote server. SCP-only servers are not supported. Both modes copy regular files, with multiple selected files queued individually. SFTP also supports one reviewed folder tree as described below. SFTP files and reviewed folder copy/merge/one-way-sync jobs can be paused and resumed. Initial SCP file payloads can resume a verified suffix using SFTP. Folders also support explicit two-way choices and mirroring; bounded UTF-8 remote files can be edited as described below. Symbolic-link copying, drag and drop and timestamp preservation are not included.

SCP commands use POSIX shell quoting and require a compatible remote SSH command shell. Use SFTP for Windows servers whose SSH command shell is `cmd.exe` or PowerShell. Windows-client SCP tests exercise the file protocol and quoting through an isolated server fixture; they do not establish compatibility with those Windows server shells.

Transfers use temporary files and ask before replacing an existing destination. Local downloads reject symlinks and unsafe remote file names. Failed/cancelled transfers try to remove their temporary files; a lost connection or app crash can leave a remote temporary file. Existing files are checked again before replacement. Conflicts can leave the prior destination in a named recovery file, reported in the transfer error. Remote checks use size/type/timestamps, so a same-size change within the timestamp resolution may be missed. Remote commits also depend on the server honoring SFTP v3's no-overwrite rename behavior. Avoid uploading over a file another process is actively updating.

The local destination filesystem must permit hard links, which ForgeCRT uses to commit a download without silently overwriting a competing file. Filesystems without hard-link support, including FAT/exFAT volumes, cannot receive downloads. Before replacing an existing local file, ForgeCRT checks this capability and leaves that file in place if the check fails. Choose another local folder or filesystem.

Cancellation stops queued jobs and active copying. Once replacement has begun, ForgeCRT waits for its outcome: an acknowledged replacement reports Completed. If the server disconnects before acknowledging a rename, the job reports an uncertain outcome, retains available recovery files and stops that transfer connection. Inspect the named paths before retrying. Quitting with an active transfer connection requires confirmation and waits for owned cleanup.

## Reviewed folder copies

In SFTP mode, select one local folder and **Upload**, or one remote folder and **Download**. ForgeCRT inspects the complete tree and opens a review showing the server, exact source and destination, file and folder counts, total bytes and included paths. The selected folder's name is appended to the opposite pane's current directory. The default **New destination** mode requires a missing destination. Choose **Merge into destination** before preparing the review to combine trees; existing files default to **Skip**. Explicit **Replace** plans replacements and rechecks their contents. Destination-only items remain.

Click **Upload folder** or **Download folder**, then confirm **Copy folder** in the native dialog to begin. The app reinspects the tree after approval and validates each child before copying it. The queue displays aggregate bytes, completed file/folder counts and the current path. Empty folders and zero-byte files are included. Only one folder can be reviewed at a time; preparation, review and copying reserve the transfer manager across all its connections so other transfers and remote changes cannot conflict. Review expires after five minutes or disconnection and cannot be reused.

Limits are 2,000 entries including the root, 32 nested levels, and 1 TiB per file and in total. Symbolic links, special files, unsafe names, parent symlinks and names that collide after case/Unicode normalization are rejected. Windows downloads also reject Windows-reserved names. Folder copies use SFTP; SCP supports individual files only.

A folder copy consists of separate new-folder and staged-file commits. It is **not atomic**. On cancellation or failure, completed files and created folders remain. ForgeCRT stops at the first failed child and reports partial progress; it does not automatically retry or roll back completed changes. Eligible SFTP folder operations can retain checkpoints for explicit resume as described below. A lost acknowledgement may mean a remote path was created even when no completion was received; inspect the reported path before retrying. Local hard-link requirements and remote metadata/path-race limitations from individual transfers also apply. New files use mode 0600 and new directories 0700. Source permissions, ownership and timestamps are not replicated. Reviewed replacements preserve ordinary destination file permissions; files with special permission bits are refused.

## Resumable SFTP files

Individual SFTP uploads/downloads use private durable recovery checkpoints. **Pause** stops read-only verification promptly or waits for the current acknowledged write chunk, then retains an existing partial file. Closing a connection or quitting also retains eligible transfers. Queued jobs and preparation stopped before a checkpoint exists are cancelled and must be started again. On reopening File Transfer, retained jobs return; connect to the same server and account, select **Resume**, and approve the native dialog. ForgeCRT verifies the authenticated account and host key, source fingerprint, parents, destination snapshot and actual retained bytes before continuing. Recovery never reconnects or runs automatically.

**Discard partial** requires native confirmation and verifies the retained file before deleting it. Local download partials can be discarded without connecting. Upload cleanup needs the original authenticated endpoint. If the commit result is uncertain, resuming is disabled: inspect the named files, then discard only the recovery record; uncertain server files remain. Changed or unrecognized partials require manual inspection. Retained jobs reserve file mutation until resumed or discarded.

Checkpoints live in the private `transfer-recovery` application-data directory. They contain paths, endpoint metadata, identity digests and fingerprints, never passwords, keys or file contents. Partial file contents remain at the destination in hidden `.termforge-*.part` files. Opening and resuming hashes the source and may take time. This is retained-file recovery, not a persistent scheduler or automatic retry queue. Up to 100 jobs are retained.

## Folder and SCP recovery

Enable resumable folder transfers before preparing a **New destination**, **Merge**, or **One-way sync** SFTP review. A private checkpoint retains the reviewed inventory, completed-file content fingerprints and the current child offset. Pause, disconnect and shutdown wait for an owned write or commit before retaining the checkpoint. Reconnect to the same authenticated server/account and approve **Resume**. The entire source and completed destination files are verified before continuation; a changed tree or unknown mkdir/commit outcome stops recovery. Two-way and Mirror operations cannot resume.

**Forget recovery** for a folder only removes the journal. It preserves completed files, created directories and any current staging file. It does not recursively clean up or undo a partially applied folder. Inspect these paths before copying again.

An initial **SCP** job sends actual legacy SCP payloads. Because that protocol has no portable offset-resume command, **Resume via SFTP** verifies the retained source/partial contents and sends the remaining suffix through SFTP on the same authenticated connection. This is a hybrid SCP/SFTP workflow and still requires server SFTP support. No SCP-only or native-SCP-offset recovery is claimed.

## One-way synchronization

Under **Sync current folders**, choose **Local → Remote** or **Remote → Local**. Synchronization compares the **current local and remote pane directories**, including nested contents. Its review lists missing files to copy, different files to replace and content-equal files to skip. SHA-256 content comparison detects changes even when size and modification time are equal. The complete reviewed trees are rechecked after approval; replacements are checked again before commit.

Destination-only entries are retained in one-way Sync mode. The separate Two-way and Mirror modes below use different reviewed decisions. Timestamp-only comparison, saved synchronization configurations, filtering and scheduling are not included. The operation is a sequence of staged file commits, so interruption can leave a partially updated tree. Folder bounds, link/name/type-conflict checks, native confirmation and five-minute review expiry also apply.

## Two-way synchronization and mirroring

**Two-way** compares the current local and remote folders using content hashes. Missing files and empty folders copy to the other side. Equal files are skipped. Every common file with different contents needs an explicit **Use local**, **Use remote**, or **Skip** choice. Review the resulting per-path directions, then apply and confirm natively. Unresolved conflicts cannot run; choices referring to files that no longer conflict are refused. This is additive synchronization without a saved baseline: it does not infer which side changed first, use newest-time winners, or propagate deletions.

**Mirror Local → Remote** or **Mirror Remote → Local** updates the chosen destination to match the reviewed source paths and contents. Its preview lists each copy, replacement, file deletion and directory deletion, with exact deletion counts. The native dialog separately warns that these target-only deletions are permanent. This is not a trash operation. Files are rechecked including content hashes immediately before deletion; target-only directories are removed in child-first order only when empty. New contents, substituted links and newly appeared matching source paths stop the operation and remain in place. Never choose the source/destination direction casually.

Both operations reject links, special files, type collisions and unsafe/case-colliding names. Plans expire after five minutes and are single-use. Reviews are bounded to 2,000 combined actions and 32 levels; content transfer is bounded to 1 TiB. They are content/path operations, not permission/owner/ACL/timestamp replication. They cannot resume and are not atomic: acknowledged copies, replacements and permanent deletions remain after cancellation or later failure. SFTP has no conditional path mutation; concurrent external writers can still race the final check. Unknown remote mutation outcomes close the connection and require inspection.

## FTP and FTPS

The File Transfer connection form offers **FTP**, **Explicit FTPS** and **Implicit FTPS** separately from SSH profiles. Credentials are transient: enter a username and respond to the masked password prompt; FTP passwords are not saved in session configuration. Plain FTP requires a native opt-in before any password prompt or connection because both credentials and data are unencrypted. FTPS requires TLS 1.2 or newer, trusted certificates and a matching hostname for both the control connection and passive data sockets. There is no insecure-certificate switch or automatic fallback to FTP.

These protocols support passive directory browsing and queued individual regular-file upload/download, progress and cancellation. Cross-host passive endpoints are refused. Directory listings are bounded to 2 MiB/10,000 entries and individual files to 1 TiB; unsafe names and symbolic links are refused. Uploads use a unique same-folder stage; downloads use a private exclusive local stage. Overwrites need native approval and recheck destination metadata. Previous replaced files remain in a named backup. Failed/cancelled jobs retain their stage path for inspection; cancellation closes the FTP connection.

FTP/FTPS does not yet support folder transfers, merge/sync/mirror, resume, remote editing or remote file-management actions. There is no user custom-CA form. FTP does not provide SSH host-key identity, portable conditional rename, or the same verified recovery guarantees as SFTP. Concurrent server changes cannot be excluded atomically. The automated tests use loopback fixtures; broader independent-server interoperability remains separate work.

## Remote text editing

Select one regular SFTP file and **Edit text**. The built-in editor accepts valid UTF-8 text up to 1 MiB; binary files, links and special permission bits are refused. Edits stay in memory. **Review changes** shows the opened and proposed text side by side. **Save remote file** then requires a native confirmation and checks the original content revision and parent paths again before replacing the file through a staged SFTP commit.

If another client changes the file, saving fails and retains your draft; reopen explicitly after resolving the conflict. Disconnects and declined confirmations also keep the in-window draft. Closing an unsaved document asks before discarding it; quitting warns about open remote buffers. Drafts are not crash recovery backups. A save acknowledged by the server is reported as saved even if the following refresh fails; reopen the file before further edits. Failed/uncertain saves can leave a named staging file for inspection. Ordinary destination permission bits are retained; ownership and timestamps are not preserved. The editor is plain text and separate from the local Monaco project workspace.

## Remote file management

Version 0.13 adds **New folder**, **Rename**, **Delete** and **Permissions** above the remote listing. Select one regular file or directory for an existing-item action. Enter the new name or three-digit permissions, then click **Review**. The application inspects the target and shows its canonical path and server. The action button opens a separate native confirmation before any mutation.

New folders use mode 0700. Rename stays within the selected directory and requires a missing destination. Delete permanently removes one regular file or empty directory; it is not recursive and does not use a trash folder. Permissions accepts 000–777 and refuses files or directories with setuid, setgid or sticky bits. Symbolic links in the target or parent path, root/dot paths and special files are rejected. The review shows permissions from fresh server metadata.

Review tokens last 60 seconds and can be used only once. Pending operations block other transfers and file changes across this transfer manager, including separately opened connections that may address the same paths. Before committing, the backend rechecks parents and target metadata, including size, timestamp, owner/group and mode. Closing the connection invalidates the review. Native confirmation can be canceled; once the mutation is sent, the app waits for its bounded outcome.

SFTP v3 provides no conditional inode-based mutation. A different process can still replace a path after the final check, and equal metadata does not prove file identity. Standard rename also depends on the server honoring no-overwrite semantics. Avoid operations on paths being changed concurrently. A timeout or lost transport after sending a mutation is reported as **outcome unknown** and closes the connection; reconnect and inspect the named paths before trying again. There is no automatic retry or rollback.

## Verification scope

Automated coverage uses synthetic credentials, temporary folders, mocked OS-encryption providers and real loopback SSH/SFTP/SCP servers. This exercises application behavior without reading the developer's keychain or connecting to a production host. Provider-injected vault tests do not establish native Keychain/DPAPI/keyring behavior. Release notes record the completed platform and native IPC checks. Real appliances, every SSH authentication combination and interactive packaged-app behavior need separate interoperability testing.

The feature inventory is informed by the user's Quick Connect reference and public documentation for [SecureCRT/SecureFX credentials](https://www.vandyke.com/support/tips/how-to-manage-credentials-in-securecrt-securefx.html) and [SecureFX file transfer](https://www.vandyke.com/products/securefx/encrypted_file_transfer.html). Full product parity is still a development goal.
