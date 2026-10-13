TermForge 0.10.0 moves Quick Connect into a separate desktop window with a standard operating-system title bar. The main terminal workspace remains available while the connection form is open. TermForge remains free, open source and MIT-licensed for macOS, Windows and Linux.

## Native Quick Connect

- Open **File → Quick Connect** or the toolbar button to show a movable, resizable window. Opening it again focuses the existing form and restores it if minimized.
- macOS uses its native close, minimize and zoom controls. Windows and Linux use their operating-system window controls. The form follows system light/dark appearance.
- Choose the protocol, hostname, port, username or saved credential, authentication order and private key. The compact layout keeps the connection fields and Cancel/Connect actions accessible.
- Open the credential manager and return to the same connection draft. The identity-file picker belongs to the Quick Connect window.
- Choose **Save session** for a reusable profile or connect without adding a saved profile. The optional startup preference shows the form without connecting automatically.
- Terminal connections open in a tab in the main workspace. SFTP connections open the graphical file browser. Starting **Transfer → File Transfer** without a selected SSH session opens Quick Connect with SFTP selected.
- Closing the window, or using Cancel/Escape on an unsubmitted form, leaves the terminal workspace and existing sessions open.

## Connection validation and retry

The auxiliary window exposes only the operations needed by Quick Connect. Main-window terminal, transfer, credential-write and automation APIs continue to reject requests from the auxiliary window. The connection request is validated before the main workspace accepts it; repeated submission and replay cannot create duplicate connections.

Saving a session and the startup preference uses one atomic configuration update. An existing profile ID supplied in a new Quick Connect request cannot overwrite that profile. Validation, save and acceptance failures appear on the form so the connection can be corrected or retried. A closed, crashed or timed-out form cannot later complete a stale connection request.

The existing encrypted credential and verified-host workflow remains in place. Managed SSH supports key/agent, password and keyboard-interactive authentication. Advanced jump-host, forwarding, certificate, GSSAPI and X11 options use System OpenSSH through Session Options. See the [credential and transfer guide](https://github.com/distractedagain/termforge/blob/main/docs/SECURE-CONNECTIONS.md).

## Scope and platform limits

This remains a preview with partial SecureCRT/SecureFX feature coverage. Quick Connect is an independent implementation; other application dialogs and terminal sessions do not become separate native windows in this update. A terminal connection still opens in the main workspace. Recursive file transfers, resume, synchronization and remote editing remain unavailable. SCP copies still require SFTP for browsing, staging and commit, plus a compatible remote SCP program and shell.

The signing setup remains macOS ad-hoc signatures without Apple notarization and unsigned Windows packages. macOS can show an unidentified-developer warning, and Keychain may ask for access again after updates. Successful native Keychain/DPAPI/secure-keyring save/unlock and installed-package interaction remain unverified. The existing native Linux storage check establishes refusal of insecure fallback storage only.

## Verification and distribution status

The local source passed 273/273 backend tests with no skips, including 22 focused window-manager/configuration tests, plus 97 existing interface checks, 21 secure-connection interface checks and 23 standalone Quick Connect interface checks. The renderer build passed and the production dependency audit reported zero vulnerabilities. Headless UI tests use synthetic connections; window-manager tests use a fake Electron implementation and real temporary configuration files.

All four [CI jobs](https://github.com/distractedagain/termforge/actions/runs/38412494525) and all four [installer builds](https://github.com/distractedagain/termforge/actions/runs/38412503136) passed at source `145b99187dab3d771217af3109372d2b0aa6ca0d`. Both Macs and Linux each passed 273 backend tests with no skips; Windows passed 266 with seven expected platform-specific skips. Both Macs and Linux each passed seven real localhost Ansible checks. Production audits reported zero vulnerabilities, and both Mac packages passed their ad-hoc signature integrity checks.

Linux passed 154 interface checks: 97 existing, 13 project-editor, 21 secure-connection and 23 standalone Quick Connect checks. Its real Electron source-app smoke verified a second native window, the restricted preload and parent IPC guards, singleton/focus behavior, close/Escape cancellation, credential-manager return, a child-owned identity picker, saved settings and exactly one real local-shell connection in the parent workspace. Existing managed SSH/SFTP, masked authentication, insecure-storage refusal, native clipboard/editor/worker and PTY checks also passed. Both screenshot captures succeeded; the JSON worker produced ten messages with no worker errors or CSP violations.

The native run used an isolated Linux Xvfb fixture. Identity/folder picker and host-approval responses were stubbed. The run does not establish macOS traffic-light pixels, interactive OS file selection, a complete application restart or installed-package behavior. No Electron window was launched on the development laptop.

See the [0.10 verification record](https://github.com/distractedagain/termforge/blob/main/docs/VERIFICATION-v0.10.0.md) for the build evidence, publication checks and remaining verification limits.
