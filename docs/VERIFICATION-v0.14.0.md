# TermForge 0.14.0 verification

Status: local implementation checks passed; platform CI and release packaging are pending. Version 0.13.0 remains the latest verified public release until this record is updated with successful platform and publication evidence.

## Scope

Reviewed SFTP folder upload/download, native approval, one-use review tokens, new-only destinations, bounded recursion, aggregate progress and partial-copy reporting. See [file transfers](SECURE-CONNECTIONS.md) for limits.

## Local checks

- 405 backend tests passed, zero failures/skips, using bounded local concurrency.
- 22 new folder-copy checks use actual loopback SSH/SFTP plus controlled filesystem/transport failures. They cover nested round trips, empty folders, source changes, destination conflicts, symlink ancestry, unsafe names, resource bounds, expiry/replay, global reservations, partial output, lost acknowledgements, cancellation and shutdown ownership.
- 108 main interface checks, 23 credential/transfer checks, 19 dedicated folder checks and 17 remote-operation checks passed. These are headless Chromium with synthetic bridges; they do not establish native IPC behavior.
- Renderer build and diff validation passed. Production dependency audit reported zero vulnerabilities.
- Independent source review found and resolved lost-acknowledgement status and pending-scan shutdown ownership issues. The reviewed folder dialog screenshot was visually inspected.

## Verification boundaries

Local backend fixtures and headless Chromium do not establish installed-app behavior. Native Electron testing runs only in Linux CI using isolated profiles, synthetic credentials and temporary loopback SFTP servers; the development laptop does not launch Electron. Native-dialog replies are injected by the smoke test.

Full SecureFX behavior has not been reverse engineered. Proprietary binaries, decompilation and artwork are not part of this repository or distribution. The folder-copy implementation was developed independently from application requirements and standard SFTP behavior.

External-server interoperability, interactive installed packages and all operating-system credential-store behaviors still need separate verification. SFTP v3 cannot eliminate remote path races or prove identity from equal metadata. macOS previews are ad-hoc signed without notarization; Windows previews are unsigned.
