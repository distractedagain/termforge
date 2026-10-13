# TermForge 0.12.0 verification

Status: local implementation and checks are in progress. The public download remains v0.11.0 until platform CI, packaging and publication are verified. Historical evidence is preserved in the [0.11 verification record](VERIFICATION-v0.11.0.md).

## Scope

The native and in-app menus share a bounded command model, dynamic availability, checkmarks and recent/snapshot entries. New actions include printing, bulk session controls, view controls, raw/text output files, ASCII capture, byte-aware Hex View and binary sending, recorded-script controls, and SSH key utilities. See [the menu guide](MENUS.md) for the exact functional coverage and unsupported reference items.

## Checks

| Check | Current result |
| --- | --- |
| Renderer build | Passed locally |
| Full backend suite | 323 passed, zero skips or failures (final local source) |
| Main interface suite | 108 passed locally; no console/page errors |
| Project / credential-transfer / Quick Connect interfaces | 13 / 21 / 23 passed locally |
| Shared menu UI | 24 passed locally; contrast, canceled log-mode changes and delayed bulk reconnect checked |
| Key utility UI | 9 passed locally, including guarded dismissal during key operations |
| macOS ARM64/Intel, Windows x64 and Linux x64 CI | Pending |
| Linux native Electron menu and connection smoke | Added; execution pending |
| Four platform installer builds and Mac signature integrity | Pending |
| Tested source tag / publisher / public asset checks | Pending |

Backend checks exercise actual temporary OpenSSH key generation/conversion and loopback SSH/TCP alongside injected transport and desktop fixtures. The key tests verify encryption, identity preservation, passphrase failure, no overwrite, bounded subprocesses and cleanup. A loopback SSH byte round trip covers all 256 byte values. Pure menu tests verify stale-command rejection, modal/child focus rules, bounded metadata, field editability and native menu rebuilds.

Headless interface checks use synthetic application bridges. They exercise actual renderer behavior without opening Electron, reading personal keys, contacting external servers or printing. Native Linux smoke separately uses the real application protocol, IPC, native Menu objects and local TCP/SSH fixtures; that evidence is pending at this point.

## Limits

The system print dialog, real printers/Save as PDF, native macOS menu pixels/accessibility, physical serial devices, installed-package interaction, external-server interoperability and secure native credential save/unlock are not established by these checks. The agent-key form uses a synthetic provider in UI tests; production listing depends on the user's separately running SSH agent. Binary-send success means bytes were queued to the transport, not that a named remote file was created.

macOS builds use ad-hoc signing without Developer ID/notarization; Windows builds are unsigned. Full SecureCRT/SecureFX equivalence is not claimed. Legacy modem-transfer protocols, detached/cascading session windows, session locking, configuration master passwords, complete XML/text imports and remote key installation remain unavailable.
