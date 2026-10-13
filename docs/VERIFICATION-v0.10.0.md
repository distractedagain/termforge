# TermForge 0.10.0 verification

Status: local source checks passed; cross-platform CI, native Linux execution, installer builds and publication are pending. This record must be finalized against the tested source revision before a 0.10.0 release is claimed. Earlier release evidence is preserved in [interface verification history](UI-VERIFICATION.md).

## Local evidence available during preparation

| Check | Result | What it establishes |
| --- | --- | --- |
| `node --test tests/quick-connect-window.test.cjs` | 22 passed, no failures/skips | Window lifecycle and restricted IPC with fake Electron; configuration behavior using real temporary files |
| Existing interface suite | 97 passed | Main-workspace workflows through a synthetic bridge, including routing to standalone Quick Connect |
| Secure-connection interface suite | 21 passed | Credential/authentication/file-browser interfaces and their updated Quick Connect routes with synthetic connections |
| Standalone Quick Connect interface suite | 23 passed | Form behavior, supported protocols, authentication order, SFTP, saved-session/startup choices, errors, cancellation and compact layouts in headless Chromium |
| Full backend suite | 273 passed, no failures/skips | Complete local backend suite, including the 22 focused tests above |
| Renderer build | Passed | Main application, standalone Quick Connect and editor-worker bundles built |
| Production dependency audit | Zero vulnerabilities | Current production dependency audit; not a general security guarantee |

The focused backend tests verify the standard native-frame constructor options (`frame: true`, `titleBarStyle: 'default'`), modeless parent relationship, sandboxed child preload, exact child sender/main-frame/document checks, and blocked navigation/popups. They exercise concurrent open/restore, failed document loads, invalid/duplicate submissions, parent acceptance/replay/timeout, failed-save retry, cancellation/crash/disposal, child menu routing and credential-manager return races.

The temporary-file tests verify a saved profile and startup preference in one configuration update, unsaved profiles without persistent IDs, protection against overwriting an existing profile ID, and unchanged configuration after invalid input or a 1,000-profile limit failure. These are behavior tests with isolated files; they do not start Electron or a terminal.

Headless UI checks render the actual form and styles with synthetic application bridges. They establish content behavior and geometry, not a native title bar, operating-system controls or real authentication. No native macOS screenshot or traffic-light appearance is verified by these images.

## Native Linux smoke — pending

`scripts/quick-connect-smoke.cjs`, integrated into `scripts/smoke-runner.cjs`, is prepared for the Linux CI Xvfb run. Its intended checks are:

- A real second BrowserWindow at `termforge://app/quick-connect.html`, with its own native window handle, parent relationship and title, while the main workspace remains open.
- A restricted child preload without Node or the main application bridge. Main-process negative tests invoke the actual registered main IPC guards with the real child sender/frame identity and require rejection before terminal writes.
- Reopening the same window, native close and Escape cancellation, native File-menu routing, and an identity-file picker owned by the child.
- Opening the credential manager, then returning to the same child with its draft preserved. No credential is created or stored by these new Quick Connect checks.
- Submitting an isolated local-shell profile through the form, saving its profile/startup preference, creating exactly one main-workspace terminal and checking real PTY output.

The identity picker response is stubbed to a temporary fixture file. Successful startup-preference persistence is checked without restarting the complete application. Focus observations are reported separately because a headless Linux environment may lack normal window-manager focus behavior. Standard frame configuration is covered by constructor tests; a Linux pass would not verify macOS traffic-light appearance.

The existing SSH/SFTP, credential, clipboard, project-worker, editor-save and PTY smoke checks remain part of the same run. Their 0.10 results are pending. No Electron window has been launched on the development laptop.

## CI, packaging and publication — pending

| Stage | 0.10.0 status |
| --- | --- |
| Tested source SHA / tag | Pending final source and successful verification |
| macOS ARM64 CI and installer build | Pending |
| macOS Intel CI and installer build | Pending |
| Windows x64 CI and installer build | Pending |
| Linux x64 CI, native smoke and installer build | Pending |
| macOS strict recursive ad-hoc signature checks | Pending for these installers |
| Publisher package/build-record/checksum verification | Pending |
| Anonymous public release/asset verification | Pending |

The distribution configuration uses macOS ad-hoc signing without Developer ID or Apple notarization; Windows packages are unsigned. That configuration is not evidence that the new packages have passed their build or signature checks. The published download remains [v0.9.0](https://github.com/distractedagain/termforge/releases/tag/v0.9.0) until publication and public verification complete.

## Remaining verification limits

Successful native macOS Keychain, Windows DPAPI and secure Linux keyring save/unlock remain unverified. Injected-provider tests establish application behavior, and the prior Linux native check establishes insecure-storage refusal. Installed-package interaction, native macOS window appearance/accessibility, Windows/Linux desktop decorations, physical serial devices, external-server interoperability, real WSL and live AI inference are not established by the new tests. This work does not claim complete SecureCRT or SecureFX equivalence.
