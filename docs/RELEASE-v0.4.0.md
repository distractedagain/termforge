TermForge 0.4.0 adds terminal color schemes and an optional matching interface to the free, MIT-licensed macOS, Windows, and Linux terminal client. This is a preview; complete SecureCRT feature parity remains in development.

## Color schemes

- Open **Options → Color Schemes…** or use the palette toolbar button. Choose Traditional, Monochrome, Solarized Dark, Solarized Light, Forge Dark, Forge Light, or High Contrast.
- Preview all sixteen ANSI colors using a local xterm sample. Each preset also defines foreground/background, cursor, and selection colors. Cancel or Escape leaves the saved configuration and live terminals unchanged.
- Enable **Match interface to default scheme** to color the toolbars, managers, tabs, and dialogs while preserving the desktop layout.
- Apply a global choice to open terminals that inherit it. Per-session overrides remain independent, and saved session appearance changes update open matching terminals without reconnecting.

The Solarized presets use [Ethan Schoonover's original palette](https://ethanschoonover.com/solarized/). See the [color-scheme guide](https://github.com/distractedagain/termforge/blob/main/docs/COLOR-SCHEMES.md) for inheritance and application-color limits.

## Installation

The packages are macOS ARM64/Intel DMG and ZIP, Windows x64 Setup/portable EXE, and Linux x64 AppImage/DEB. Each platform has a `BUILD_INFO` record; `SHA256SUMS.txt` covers all eight packages and four build records.

macOS packages use ad-hoc signatures and are not Apple notarized; Windows packages are unsigned. If macOS reports an unidentified developer or cannot verify the app for malware, first try opening your trusted release copy of **TermForge**. Then open **System Settings → Privacy & Security**, scroll to **Security**, click **Open Anyway** for TermForge, and click **Open** in the confirmation. This grants an exception to that app. See [Apple's official instructions](https://support.apple.com/en-us/102445).

SSH and SFTP require installed system clients. Python automation requires an installed Python 3 interpreter. Existing TermForge and historical Harbor configuration support continues.

## Verification

The local source passed **92 backend tests and 63 headless interface checks**, with no failures or browser console errors. Coverage includes complete palettes, validation and persistence, inheritance, actual xterm previews, cancellation, asynchronous save errors, live terminal updates, and optional interface matching. Headless interface checks use a synthetic application bridge.

Publication requires successful native test/build/package jobs for macOS ARM64, macOS Intel, Windows x64, and Linux x64 at the exact tagged commit. The publisher checks every artifact's provenance and SHA-256 hashes before publishing. Windows skips POSIX-only checks; macOS packages additionally pass strict recursive ad-hoc signature verification. Each `BUILD_INFO` records the source commit and test scope. Packaged interactive runtime testing is not claimed.

[Native CI](https://github.com/distractedagain/termforge/actions/runs/38324020057), [packaging](https://github.com/distractedagain/termforge/actions/runs/38324019614), and [publication](https://github.com/distractedagain/termforge/actions/runs/38325248387) succeeded for tagged source `0e9ae540293fac90d0c31649705fed6fdb2f2df3`. Both Macs and Linux passed 92 backend tests; Windows passed 89 with three POSIX-only skips. Linux passed 63 headless checks. Windows packaging needed one retry after interpreter-start and UDP-fixture timeouts; the retry passed with unchanged source and assertions. Anonymous checksum/build-record downloads matched GitHub's asset digests and the tagged source.

The installed v0.3 macOS preview has limited user-reported launch, local-shell, and SSH success. That feedback does not certify the new 0.4 packages or all connection workflows. The [feature ledger](https://github.com/distractedagain/termforge/blob/main/docs/SECURECRT-PARITY.md) tracks remaining functionality and integration gaps.
