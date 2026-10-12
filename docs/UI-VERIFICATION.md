# Harbor Terminal 0.2.0 classic interface QA

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
