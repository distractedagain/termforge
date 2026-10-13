TermForge 0.11.0 brings its docked sidebars closer to the SecureCRT macOS layout while retaining TermForge's existing connection, command and terminal workflows. TermForge remains free, open source and MIT-licensed for macOS, Windows and Linux.

## Docked desktop managers

- Full vertical **Session Manager**, **Command Manager** and **Active Sessions** tabs run down the left edge.
- Each manager has a centered caption, circular close control, compact monochrome toolbar and an inset tree with smaller, square rows.
- Light mode uses blue selection and cyan folder icons. Dark mode and optional matching schemes, including Solarized, retain their colors.
- The caption's close control collapses the content while preserving the rail. Select a rail tab to reopen the manager at its previous width. Resizing and collapse preferences remain local to your workspace.
- Arrow Up/Down, Home and End move focus among rail tabs; Enter or Space opens the focused manager. Existing session-tree keyboard navigation remains available.
- **More session actions** exposes existing session/folder commands beside the toolbar. Keyboard folder selection keeps the highlighted item and connection target in agreement.

Session, command and active-session filtering remain available. The narrowest sidebar sizes keep the toolbar inside a horizontally scrollable area. Project mode continues to use its separate project explorer.

## Scope and installation

This is an independent interface implementation with partial SecureCRT/SecureFX feature coverage. Floating managers, pin/auto-hide behavior and sidebar cut/copy/paste operations are not added. Quick Connect retains its separate native desktop window introduced in 0.10.

macOS packages use ad-hoc signatures without Apple notarization; Windows packages are unsigned. Installed-package interaction and native macOS appearance/accessibility are not established by headless interface checks. The update does not change credential-storage or file-transfer guarantees.

See the [0.11 verification record](https://github.com/distractedagain/termforge/blob/main/docs/VERIFICATION-v0.11.0.md) for source, interface, platform-build and release-integrity evidence, including remaining limits.
