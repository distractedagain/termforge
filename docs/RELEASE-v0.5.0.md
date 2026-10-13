TermForge 0.5.0 adds independent tab groups and detailed workspace snapshots to the free, MIT-licensed macOS, Windows, and Linux terminal client. This is a preview; complete SecureCRT feature parity remains in development.

## Tab groups

- Use **Window → New Vertical Tab Group** or **New Horizontal Tab Group** to split a selected tab into its own group.
- Each group retains its selected terminal. Drag tabs between groups or use **Move Tab to Next Group** without restarting their connections.
- Resize splits with the mouse or keyboard. **Collapse Tab Groups** returns to one tab strip, and the existing horizontal, vertical and grid tile commands remain available.
- Closing a group's last tab removes its empty pane. Reconnecting retains the tab's group and position.

## Workspace snapshots

Snapshots preserve each saved-session connection, including repeats, tab order, each group's selected tab, focused group, split arrangement and relative pane sizes. **Select** highlights profiles without rearranging current terminals. **Connect…** reviews targets, then restores beside existing tabs. Partial failures retain successful connections and report the result.

Older snapshots remain readable. Import remaps colliding profile IDs throughout the snapshot; deleting a profile removes its instances and repairs the remaining layout. Unsaved quick connections must be saved as profiles first. Snapshots do not retain terminal output, authentication or running programs. See the [tab group guide](https://github.com/distractedagain/termforge/blob/main/docs/TAB-GROUPS.md).

## Installation and verification

The packages are macOS ARM64/Intel DMG and ZIP, Windows x64 Setup/portable EXE, and Linux x64 AppImage/DEB. The release contains platform build records and a SHA-256 manifest. macOS packages use ad-hoc signatures and remain unnotarized; Windows packages remain unsigned. SSH/SFTP use installed system clients, and Python automation requires an installed Python 3 interpreter.

Publication requires passing native test/build/package jobs on all four targets at the tagged source commit. The publisher verifies every package's build provenance and SHA-256 hash. Headless interface checks use a synthetic application bridge; packaged interactive runtime coverage is not claimed. No local Electron window is launched for these checks.

The local source passed **115 backend tests and 72 headless interface checks**, with no failures or browser console errors. Coverage includes strict snapshot validation, legacy loading, import/delete repair, duplicate instances, nested splits, per-group selection, drag movement, keyboard/pointer resizing, reconnect placement, partial restores and retained terminal output. Production dependency auditing found no reported vulnerabilities at this checkpoint.

[Native CI](https://github.com/distractedagain/termforge/actions/runs/38328313996), [packaging](https://github.com/distractedagain/termforge/actions/runs/38328332260), and [publication](https://github.com/distractedagain/termforge/actions/runs/38328921919) passed on their first attempt at tagged source `a3697bcbb7c803edfde80d23e5c5769c621671ba`. Both Macs and Linux passed 115 backend tests each; Windows passed 112 with three expected POSIX-only skips. Linux passed 72 headless checks. Both Mac packages passed strict recursive ad-hoc signature verification. All thirteen public assets were checked against the published digests; anonymous checksum/build-record downloads confirmed the exact tagged source. Packaged interactive testing remains pending.

Moving live tabs between windows, selected-group broadcasting, floating managers, custom palette editing and the other gaps in the [parity ledger](https://github.com/distractedagain/termforge/blob/main/docs/SECURECRT-PARITY.md) remain future work.
