# TermForge 0.11.0 verification

Status: all four [CI jobs](https://github.com/distractedagain/termforge/actions/runs/38419528717) and [installer builds](https://github.com/distractedagain/termforge/actions/runs/38419535573) passed on October 13, 2026, at source `2d8ba8f7316234ab421e7627738e8b7ed59262f0`. [Version 0.11.0 is published](https://github.com/distractedagain/termforge/releases/tag/v0.11.0), and its source tag and public assets passed independent anonymous verification. Earlier evidence is preserved in the [0.10 verification record](VERIFICATION-v0.10.0.md).

## Scope

The docked managers gain a vertical text rail, compact captions/toolbars, inset trees, collapse/reopen with retained width, keyboard navigation and a More actions button. Selection highlighting and folder connection targets remain consistent. Light-mode blue selection/cyan folders and dark/matching palettes are scoped to the managers. Project mode retains its own explorer.

## Evidence checklist

| Check | Current result | Meaning |
| --- | --- | --- |
| Renderer build | Passed | Application, Quick Connect and editor-worker bundles build locally |
| Main interface suite and sidebar screenshots | 108 passed locally and in Linux CI, including 11 sidebar checks; no console/page errors | Synthetic navigation, selection, collapse, persistence, actions, themes and compact layouts |
| Other Linux interface suites | 13 project, 21 secure-connection and 23 Quick Connect checks passed | 165 total interface checks including the main suite |
| Backend tests in platform CI | 273 passed on each Mac and Linux; Windows 266 passed with seven expected platform-specific skips | No failures; exact source above |
| Real localhost Ansible checks | Seven passed on each Mac and Linux | Isolated syntax/check/run/failure/cancellation fixtures |
| Production dependency audits | Zero vulnerabilities on all four platforms | Dependency audit at verification time |
| Linux native Electron smoke | Passed | Real window, IPC, PTY, SSH/SFTP and editor fixtures |
| Four platform installer builds | Passed | Package construction, build records and retained artifacts |
| Both macOS ad-hoc signature integrity checks | Passed | Signature integrity; no Apple notarization |
| Release tag verification | Passed | `v0.11.0` resolves to the tested source above |
| Publisher and anonymous public-asset verification | Passed | Thirteen assets, twelve checksum entries and four matching build records |

The native Linux run verified Quick Connect isolation/singleton/cancellation and one parent PTY, loopback SSH/SFTP and host-key handling, masked authentication, clipboard/editor saves and no editor-to-terminal writes. Both screenshots succeeded; the JSON worker returned ten messages with no worker errors or CSP violations. Linux refused insecure `basic_text` storage; secure storage was unavailable. Identity/folder selection and host approval used fixture responses.

## Public release verification

The [publisher](https://github.com/distractedagain/termforge/actions/runs/38420903173) rehashed and validated the four platform build artifacts before publishing eight installers/archives, four build records and a checksum manifest. Independent anonymous verification confirmed public preview release `411821551`, the exact source tag and all thirteen uploaded assets on October 13, 2026. All twelve manifest entries match GitHub's SHA-256 asset digests.

The manifest and four small build records were downloaded anonymously and independently hashed. Every record identifies version 0.11.0, the tested commit and the expected platform, architecture and signing status. Installer bytes were not downloaded or independently rehashed during the public check; their manifest entries were compared with GitHub's asset digests.

## Verification limits

Headless Chromium uses synthetic connections and bridges. It verifies renderer behavior and geometry, not installed applications or native macOS appearance/accessibility. Native Electron ran only in Linux CI under Xvfb; no Electron window was launched on the development laptop.

macOS packages remain ad-hoc signed without Developer ID/notarization; Windows packages are unsigned. Package construction does not establish installed interaction. Successful native Keychain/DPAPI/secure-keyring save/unlock, physical serial devices, external hosts, real WSL and live AI inference remain unverified.

Floating managers, pin/auto-hide and full SecureCRT/SecureFX equivalence are not claimed.
