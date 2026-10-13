# TermForge 0.12.0 verification

Status: all four [CI jobs](https://github.com/distractedagain/termforge/actions/runs/38431889410) and [installer builds](https://github.com/distractedagain/termforge/actions/runs/38431893367) passed on October 13, 2026, at source `5dad1ad30e16436d3317f73433ceb754bd1c2f25`. [Version 0.12.0 is published](https://github.com/distractedagain/termforge/releases/tag/v0.12.0), and its source tag and public assets passed independent anonymous verification. Historical evidence is preserved in the [0.11 verification record](VERIFICATION-v0.11.0.md).

## Scope

The native and in-app menus share a bounded command model, dynamic availability, checkmarks and recent/snapshot entries. New actions include printing, bulk session controls, view controls, raw/text output files, ASCII capture, byte-aware Hex View and binary sending, recorded-script controls, and SSH key utilities. See [the menu guide](MENUS.md) for the exact functional coverage and unsupported reference items.

## Evidence checklist

| Check | Verified result |
| --- | --- |
| Renderer build | Passed locally and on all four platform CI/package jobs |
| Backend tests in platform CI | 338 passed on each Mac and Linux; Windows 330 passed with eight expected platform-specific skips; zero failures |
| Main interface suite | 108 passed locally and in Linux CI; no console/page errors |
| Project / credential-transfer / Quick Connect interfaces | 13 / 21 / 23 passed locally and in Linux CI |
| Shared menu UI | 24 passed locally and in Linux CI; contrast, canceled log-mode changes and delayed bulk reconnect checked |
| Key utility UI | Nine passed locally and in Linux CI, including guarded dismissal during key operations |
| Total interface checks | 198 passed in Linux CI |
| Real localhost Ansible checks | Seven passed on each Mac and Linux |
| Production dependency audits | Zero vulnerabilities on all four platforms at verification time |
| Linux native Electron smoke | Passed, including all 15 native menu checks and the unchanged zero-console-errors assertion |
| Windows key utility diagnostic | [Passed](https://github.com/distractedagain/termforge/actions/runs/38431888959): encrypted generation and conversion, followed by clean process exit |
| Four platform installer builds | Passed; package backend checks also passed |
| Both macOS ad-hoc signature integrity checks | Passed strict recursive verification; no Apple notarization |
| Tested source tag / publisher / public asset checks | Passed: exact source tag, thirteen assets, twelve checksum entries and four matching build records |

Backend checks exercise actual temporary OpenSSH key generation/conversion and loopback SSH/TCP alongside injected transport and desktop fixtures. Key tests verify encryption, identity preservation, passphrase failure, no overwrite, bounded subprocesses and cleanup. A loopback SSH byte round trip covers all 256 byte values. Pure menu tests verify stale-command rejection, modal/child focus rules, bounded metadata, field editability and native menu rebuilds.

Headless interface checks use synthetic application bridges. They exercise actual renderer behavior without opening Electron, reading personal keys, contacting external servers or printing. Native Linux smoke separately uses the real application protocol, IPC, native Menu objects and local TCP/SSH fixtures. It verifies all 256 outgoing byte values at the TCP peer, plus incoming ANSI/text and malformed UTF-8 bytes in the raw log and Hex View. Picker and confirmation responses use isolated fixtures. The existing native Quick Connect, clipboard, PTY, SSH/SFTP and editor checks also pass. No Electron window was launched on the development laptop.

## Issues resolved before release

Earlier candidates were not published. The first native menu run exposed a fixture that echoed malformed terminal escape sequences into xterm.js. The fixture now separates outgoing-byte verification from incoming display/raw-log checks; console assertions were not relaxed, and the corrected final smoke passes.

Windows key-generation/conversion checks initially failed, then exposed a lingering console worker. The final implementation supplies OpenSSH's required ProgramData environment variable, uses a private ConPTY console with ordered prompts, supports termination before first output and disposes owned console resources after exit. The adapter is pinned to node-pty 1.1.0 and checks the minimum supported Windows build before spawning. All five real generation/conversion tests pass in the final Windows CI and package jobs; the separate encrypted-key diagnostic also exits cleanly.

A reproduced upstream Ed25519 generator defect was isolated to test fixtures. Fixtures now validate generated keys and narrowly retry the malformed-generation case; production generation uses OpenSSH. Real SSH authentication also passes with a valid key whose public bytes begin with two zero bytes.

## Public release verification

The [publisher](https://github.com/distractedagain/termforge/actions/runs/38433492178) rehashed and validated the four platform build artifacts before publishing eight installers/archives, four build records and a checksum manifest. Independent anonymous verification confirmed public preview release `411902927`, the exact source tag and all thirteen uploaded assets on October 13, 2026. All twelve manifest entries match GitHub's SHA-256 asset digests.

The manifest and four small build records were downloaded anonymously and independently hashed. Every record identifies version 0.12.0, the tested commit and the expected platform, architecture and signing status. Installer bytes were not downloaded or independently rehashed during the public check; their manifest entries were compared with GitHub's asset digests.

## Verification limits

The system print dialog, real printers/Save as PDF, native macOS menu pixels/accessibility, physical serial devices, installed-package interaction, external-server interoperability and secure native credential save/unlock are not established by these checks. The agent-key form uses a synthetic provider in UI tests; production listing depends on the user's separately running SSH agent. Binary-send success means bytes were queued to the transport, not that a named remote file was created. Native Electron runs in Linux CI under Xvfb; package construction does not establish installed interaction on any platform.

macOS builds use ad-hoc signing without Developer ID/notarization; Windows builds are unsigned. Full SecureCRT/SecureFX equivalence is not claimed. Legacy modem-transfer protocols, detached/cascading session windows, session locking, configuration master passwords, complete XML/text imports and remote key installation remain unavailable.
