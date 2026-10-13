# TermForge 0.10.0 verification

Status: local checks, all four platform CI jobs, native Linux execution and all four installer builds passed at source `145b99187dab3d771217af3109372d2b0aa6ca0d`. Publication, tag and public asset verification remain pending. Earlier release evidence is preserved in [interface verification history](UI-VERIFICATION.md).

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

## Native Linux smoke — passed

`scripts/quick-connect-smoke.cjs`, integrated into `scripts/smoke-runner.cjs`, passed in the [Linux CI job](https://github.com/distractedagain/termforge/actions/runs/38412494525/job/115348164760) under Xvfb. The actual `quick-connect-native.json` records every assertion below as true:

- A real second BrowserWindow at `termforge://app/quick-connect.html`, with its own native window handle, parent relationship and title, while the main workspace remains open.
- A restricted child preload without Node or the main application bridge. Main-process negative tests invoke the actual registered main IPC guards with the real child sender/frame identity and require rejection before terminal writes.
- Reopening the same window, native close and Escape cancellation, native File-menu routing, and an identity-file picker owned by the child.
- Opening the credential manager, then returning to the same child with its draft preserved. No credential is created or stored by these new Quick Connect checks.
- Submitting an isolated local-shell profile through the form, saving its profile/startup preference, creating exactly one main-workspace terminal and checking real PTY output.

The identity picker response was stubbed to a temporary fixture file. Successful startup-preference persistence was checked without restarting the complete application. Focus was observed successfully in this run and is recorded separately because a headless Linux environment may lack normal window-manager focus behavior. Standard frame configuration is covered by constructor tests; the Linux pass does not verify macOS traffic-light appearance.

The same native run passed existing real PTY/OpenSSH, managed SSH/SFTP, masked authentication/cancellation, host-key verification/refusal and insecure Linux `basic_text` storage-refusal checks. Native clipboard completion, YAML/JSON saves and no editor-to-terminal writes passed. The JSON worker returned ten messages with no errors, no CSP violations were recorded, and both desktop/editor PNG captures succeeded. `result.json` records `behavioralChecksPassed: true`. Host-approval and folder-picker responses were stubbed for the isolated fixtures. No Electron window was launched on the development laptop.

## CI and packaging — passed; publication pending

All four [CI jobs](https://github.com/distractedagain/termforge/actions/runs/38412494525) and all four [installer builds](https://github.com/distractedagain/termforge/actions/runs/38412503136) completed successfully at the same source revision. The platform counts below were read from each completed job's log.

| Stage | 0.10.0 status |
| --- | --- |
| Tested source SHA | `145b99187dab3d771217af3109372d2b0aa6ca0d` |
| Release tag verification | Pending |
| macOS ARM64 CI and installer build | Passed; 273 backend tests, no skips; seven real localhost Ansible checks |
| macOS Intel CI and installer build | Passed; 273 backend tests, no skips; seven real localhost Ansible checks |
| Windows x64 CI and installer build | Passed; 266 backend tests, seven expected POSIX/symlink skips, no failures |
| Linux x64 CI, native smoke and installer build | Passed; 273 backend tests, no skips; seven real localhost Ansible checks; 154 interface checks and native smoke |
| macOS ad-hoc signature integrity checks | Passed for both architectures; no Apple notarization |
| Publisher package/build-record/checksum verification | Pending |
| Anonymous public release/asset verification | Pending |

The 154 Linux interface checks comprise 97 main-workspace, 13 project-editor, 21 secure-connection and 23 standalone Quick Connect checks. Production dependency audits reported zero vulnerabilities on all four platforms. Both Macs used Python 3.13.15 and Linux used Python 3.13.16 for Ansible Core 2.21.5 and Runner 2.4.3. Those localhost checks do not contact network devices or establish real WSL support.

The macOS packages use ad-hoc signing without Developer ID or Apple notarization; Windows packages are unsigned. The successful builds and signature checks establish package construction, not installed-package interaction. The published download remains [v0.9.0](https://github.com/distractedagain/termforge/releases/tag/v0.9.0) until publication and public verification complete.

## Remaining verification limits

Successful native macOS Keychain, Windows DPAPI and secure Linux keyring save/unlock remain unverified. Injected-provider tests establish application behavior, and the prior Linux native check establishes insecure-storage refusal. Installed-package interaction, native macOS window appearance/accessibility, Windows/Linux desktop decorations, physical serial devices, external-server interoperability, real WSL and live AI inference are not established by the new tests. This work does not claim complete SecureCRT or SecureFX equivalence.
