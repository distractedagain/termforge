# TermForge interface verification

## TermForge 0.9 credentials and file transfer

The local source passed **251/251 backend tests**, **97/97 existing interface checks**, **20/20 secure-connection interface checks** and **13/13 project-editor checks**, with no failures or browser errors. The Linux job in [final-source CI](https://github.com/distractedagain/termforge/actions/runs/38407745105) passed these suites at `90f81ac7e2620f837b344b287cc68816df6bca2f`, plus seven real localhost Ansible checks. Native Electron ran only under Linux CI's Xvfb, never on the development laptop.

The new headless UI suite exercises named-credential creation/replacement/deletion, secret-field clearing, unavailable-storage controls, ordered authentication, private prompt cancellation, session editing and startup preferences. It also verifies two-pane navigation, multiple-file selection, SFTP/SCP queue requests, progress/cancellation, disconnect handling and compact/light layouts. Its credentials, servers and transfer events are synthetic. The backend tests separately use real loopback SSH/SFTP servers and the system SCP program. Injected hard-link failures verify that unsupported local filesystems leave an existing download destination in place.

The final Linux native Electron smoke uses actual main/preload IPC and an isolated loopback server. It verifies:

- Managed SSH shell communication, host verification before authentication and changed-key refusal.
- Real masked authentication forms, clearing after response/cancellation, and no password writes through the terminal input path.
- A 140,000-byte SFTP upload/download round trip with exact data checks.
- Refusal to save credentials when Electron selects the insecure Linux `basic_text` backend.
- Existing clipboard completion, YAML/JSON saves, PTY and OpenSSH checks; ten JSON-worker messages, no worker errors or CSP violations, and both PNG captures.

Host-trust, credential-approval and folder-picker responses are stubbed for the isolated fixture. Native storage evidence verifies **refusal of insecure storage**, not successful encryption/decryption with macOS Keychain, Windows DPAPI or a secure Linux keyring. Those positive platform integrations remain unverified; injected providers establish only application logic. This smoke uses the source app, not an installed release package. Windows-server SCP shell compatibility, real WSL, live AI inference and external-device interoperability are not established.

See [0.9 release notes](RELEASE-v0.9.0.md) for the final cross-platform build and publication record, and [credential and transfer limits](SECURE-CONNECTIONS.md) for supported filesystems, authentication and server requirements.

## TermForge 0.8 project workspace — source verification

The existing **97/97 headless interface checks** and **13/13 project interface checks** passed with no browser console/page errors. The local backend suite passed **200/200 tests**, with no failures or skips. Linux CI also passed all three suites at source `c2d00e3c9284a6c304f821cf2698a50f46dce847`. No interactive release-package or real WSL result is claimed by this report.

`scripts/project-ui-check.cjs` exercises the bundled Monaco editor through headless Chromium. Its project bridge uses real temporary files and a temporary Git repository; AI responses and Ansible run events are synthetic. Passed coverage includes edit/save conflicts, same-folder reopening, backup preview/restoration, Git diffs, native-menu event handling for editor actions, reviewed AI file proposals, Ansible trust/confirmation/cancellation controls, local JSON worker validation, and compact/light layouts. The existing terminal/AI harness uses synthetic sessions and model responses.

Separately, `scripts/ansible-check.cjs` passed **7/7 real localhost integration checks** using Python 3.14.8, Ansible Core 2.21.5 and Runner 2.4.3. That integration creates and removes a temporary localhost fixture; it verifies runtime availability, syntax, supported check/diff behavior, an explicit fixture write, changed-input rejection, task failure and cancellation. It does not contact network devices or prove every collection's behavior.

No Electron window was launched on the development laptop. Real WSL, packaged interaction and live model inference remain outside this evidence.

The expanded `npm run smoke` passed in the [Linux CI job](https://github.com/distractedagain/termforge/actions/runs/38342881401/job/115117592974) at that source. It ran the source app in real Electron under Xvfb and verified:

- The actual preload/native clipboard path, with write completion awaited before acknowledgement, complete-document copy and editor paste.
- YAML and JSON edits saved to real fixture files without writing to any open terminal.
- The actual JSON worker over `termforge://`, with **10 worker messages, zero worker errors**, and diagnostics that cleared after correction.
- **Zero CSP violations**, plus successful desktop and editor PNG captures.
- Existing real PTY, terminal/broadcast and isolated loopback SSH checks.

The native folder-selection result is stubbed, so this establishes the IPC path rather than interactive OS-picker behavior. The Electron run did not use an installed release package. Earlier CI attempts exposed an Xvfb capture problem and an asynchronous clipboard assumption; the final run retains strict worker, clipboard and save assertions and includes the clipboard IPC completion correction. Screenshot availability is recorded separately, with a warning if capture fails; both captures succeeded in the final run.

All four [CI jobs](https://github.com/distractedagain/termforge/actions/runs/38342881401) and all four [packaging jobs](https://github.com/distractedagain/termforge/actions/runs/38342904453) passed at the same source; packaging succeeded on its first attempt. Both Macs and Linux passed 200 backend tests each; Windows passed 195 with five expected POSIX/symlink skips. The two Macs and Linux also passed all 7 real localhost Ansible checks. The final Intel Mac run used Python 3.13.15, Ansible Core 2.21.5 and Runner 2.4.3. Both Mac packages passed `codesign --verify --deep --strict`, with ad-hoc signatures and no Developer ID or notarization. Build success and the Linux source-app smoke do not establish interactive packaged behavior on all platforms.

## TermForge 0.7 modern interface — historical verification

The 0.7.0 source passed **97/97 headless interface checks**, with no browser console/page errors. Coverage included compact layouts, light/dark and matching palettes, keyboard access, reduced motion, explicit AI review and layout persistence across restart. Terminals and AI responses were synthetic. These results apply to that release and do not establish packaged interactive behavior. See [the 0.7 release record](RELEASE-v0.7.0.md) for source and distribution evidence.

## Harbor Terminal 0.2.0 classic interface — historical QA

20 headless renderer checks passed. No browser console errors were recorded.

This was an isolated Playwright Chromium headless-shell run against a read-only local HTTP server. Electron and visible browser windows were never launched. All sessions, hosts, process responses, and terminal output came from an in-memory synthetic fixture. No SSH/SFTP connection, local shell process, credentials, or saved user configuration was used.

Verified behavior:

- Compact menu bar (27 px), toolbar (34 px), nested Session Manager tree, terminal tabs, Command Window, Button Bar, and status bar.
- All eight menu groups expose supported actions. File New Session and Options Global Options open their dialogs. View menu checkboxes hide and restore each pane.
- Single click selects without connecting; double click and keyboard Enter open exactly the selected profile. Toolbar Connect follows the selected profile.
- New session starts with blank name/host and SSH port 22. Classic light appearance and 14-point fixture terminal font remain selected.
- Button Bar inserts the command for review without sending. Broadcast opens an exact command/three-target preview; cancel sends nothing and accept sends only the confirmed command.
- Tile mode shows all three synthetic terminals. Keyboard splitters and a viewport resize retain positive integer terminal dimensions. Both 1280×800 and 850×600 fit without document overflow; status bar remains visible.
- Disconnect requests confirmation, keeps output in its tab, and disables the disconnect tool after completion.
- Native menu event dispatch reaches Connect, New Session, Find, Session Manager, Command Window, Button Bar, Global Options, Help, and SFTP actions. SFTP with a selected remote profile opens a synthetic SFTP session; without selection it opens an unconnected SFTP dialog.
- A saved session name containing an HTML-like image tag is displayed as literal text. It creates no image element, runs no fixture marker, and opens no connection.
- Windows and Linux renderer platform labels and Ctrl shortcut hints initialize correctly. Native binaries on those operating systems were not exercised.

Clean previews, captured before the isolated injection test:

- `classic-demo-active-1280x800.png`: selected router in a nested folder, one terminal tab, and explicitly labeled DEMO SESSION output.
- `classic-demo-active-850x600.png`: multiple synthetic tabs, active terminal view.
- `classic-demo-tiles-850x600.png`: three synthetic sessions in tile mode.
- `classic-empty-1280x800.png` and `classic-empty-850x600.png`: clean unconfigured workspace.

`report.json` contains per-check results and geometry evidence. `fixture.cjs` and `run.cjs` contain the isolated fixture and repeatable harness. Browser and server processes were closed by the harness after the run.

## TermForge 0.5 tab group verification

On October 12, 2026, the complete `scripts/ui-check.cjs` harness passed **72/72 checks**, with no renderer console/page errors. It uses a synthetic bridge and real xterm rendering; it does not launch Electron or real terminal processes.

New checks cover independent active tabs and focused command routing; cross-group drag with retained output and no transport restart; keyboard and pointer resizing, including a resize after moving a tab; collapse with preserved order; reconnect placement with delayed opening and close-on-exit enabled; repeated saved-session instances; per-group selection and ratio restoration beside existing groups; failed active-tab fallback; and pruning a wholly failed group. Existing palette, dialogs, synthetic transfer/script and platform layout checks remain included.

The clean `docs/images/tab-groups-solarized-dark.png` image shows three groups, four synthetic connections (including two instances of the router profile), and matching Solarized Dark chrome at 1280×800. The screenshot was visually inspected. Native macOS title/menu controls are not shown. These checks establish renderer behavior with a simulated bridge, not full SecureCRT visual parity or packaged native behavior.
