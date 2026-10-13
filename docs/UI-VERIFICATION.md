# TermForge interface verification

## TermForge 0.8 project workspace — local verification

The existing **97/97 headless interface checks** and **13/13 project interface checks** passed with no browser console/page errors. The local backend suite passed **200/200 tests**, with no failures or skips. Native CI results are pending; no packaged desktop or real WSL result is claimed by this report.

`scripts/project-ui-check.cjs` exercises the bundled Monaco editor through headless Chromium. Its project bridge uses real temporary files and a temporary Git repository; AI responses and Ansible run events are synthetic. Passed coverage includes edit/save conflicts, same-folder reopening, backup preview/restoration, Git diffs, native-menu event handling for editor actions, reviewed AI file proposals, Ansible trust/confirmation/cancellation controls, local JSON worker validation, and compact/light layouts. The existing terminal/AI harness uses synthetic sessions and model responses.

Separately, `scripts/ansible-check.cjs` passed **7/7 real localhost integration checks** using Python 3.14.8, Ansible Core 2.21.5 and Runner 2.4.3. That integration creates and removes a temporary localhost fixture; it verifies runtime availability, syntax, supported check/diff behavior, an explicit fixture write, changed-input rejection, task failure and cancellation. It does not contact network devices or prove every collection's behavior.

No local Electron window was launched for these checks. Real WSL, packaged interaction and live model inference remain outside this evidence.

The expanded `npm run smoke` check is configured for Linux CI only and has not yet run at this source revision. It will exercise the actual Electron preload bridge, JSON worker messages/diagnostics over `termforge://`, native clipboard copy/paste, real fixture-file saves, CSP behavior and absence of terminal writes from editor actions. The native folder-selection result is stubbed, so it does not establish interactive OS-picker behavior. Existing PTY and isolated loopback SSH checks remain part of that smoke. Source configuration alone is not a passing native result.

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
