# TermForge 0.11.0 verification

Status: the local renderer build and 108 headless interface checks passed on October 13, 2026, with no console/page errors. Full backend checks, platform CI, installer builds, tag verification and publication remain pending. The public download remains v0.10.0 until the new release is verified and published. Earlier evidence is preserved in the [0.10 verification record](VERIFICATION-v0.10.0.md).

## Scope

This update changes the docked manager markup, scoped styling and workspace behavior: a vertical text rail, compact captions/toolbars, consistent inset trees, collapse/reopen with retained width, keyboard rail navigation and existing context actions exposed through a More button. It also keeps the selection highlight and connection target in agreement when navigating from an individual session to a folder. Project mode continues to hide the terminal managers in favor of its own explorer.

Light-mode managers use blue selection and cyan folders. Dark mode and optional matching interface palettes use their existing colors. The sidebar styling is scoped so terminal colors and the rest of the workspace retain their appearance.

## Evidence checklist

| Check | Current result | Meaning |
| --- | --- | --- |
| Renderer build | Passed | Application, Quick Connect and editor-worker bundles build locally |
| Main interface suite and sidebar screenshots | 108 passed, including 11 sidebar checks; no console/page errors | Synthetic bridge checks for manager navigation, selection, collapse, persistence, actions, themes and compact layouts |
| Project, secure-connection and Quick Connect interface suites | Pending | Regression coverage for existing interfaces |
| Full backend suite | Pending | Existing backend behavior at the new revision |
| Production dependency audit | Pending | Dependency audit result at verification time |
| macOS ARM64/Intel, Windows x64 and Linux x64 CI | Pending | Platform source/test results |
| Linux native Electron smoke | Pending | Existing real Electron window, IPC, terminal, credential/transfer and editor fixtures |
| Four platform installer builds | Pending | Package construction and build-record provenance |
| Both macOS ad-hoc signature integrity checks | Pending | Signature integrity; does not provide Apple notarization |
| Tested source SHA and release tag | Pending | Exact source identity |
| Publisher and anonymous public-asset verification | Pending | Installer/build-record/checksum consistency and public release identity |

## Verification limits

Headless Chromium checks use synthetic connection data and application bridges. They verify renderer behavior and geometry, not installed applications, native macOS window decorations or external-server interoperability. No Electron window is launched on the development laptop for this update. Screenshots must identify their synthetic/headless origin when published.

The macOS distribution remains ad-hoc signed without Developer ID or notarization; Windows packages remain unsigned. Installer construction and checksum verification do not establish successful installation or interactive packaged behavior. Successful native macOS Keychain, Windows DPAPI and secure Linux keyring save/unlock remain outside this sidebar change's verification scope. Physical serial devices, external hosts, real WSL and live AI inference are likewise not established by these checks.

Floating managers, pin/auto-hide behavior and full SecureCRT/SecureFX equivalence are not claimed. Prior-version results remain historical until corresponding checks pass at the new source revision.
