# ForgeCRT 0.17.0 verification

Status: implementation and verification in progress. Version 0.16.0 remains the latest verified public release until all v0.17 source, packaging and publication gates pass.

## Scope

FTP, explicit FTPS and implicit FTPS folder copy/merge and durable file/folder recovery; persistent SFTP two-way content baselines with reviewed deletion propagation, saved pair selection, root loading and explicit baseline removal.

## Local evidence

- Complete backend suite: **611 passed**, zero failures/skips, with bounded test concurrency.
- FTP coverage: **55 protocol, recovery and adversarial tests**, using real loopback FTP and explicit/implicit FTPS. Cases include REST/APPE suffixes, restart recovery, completed-child receipts, reviewed merges, changed sources/targets, trusted certificate rotation, ignored/refused REST, refused APPE, lost completion/mkdir/rename acknowledgements, stage substitution, unsafe journals, shutdown and depth limits.
- Persistent synchronization: 16 new folder/wire cases plus 11 storage/adversarial cases cover consecutive generations, changes on either side, file/subtree/root deletion, conflict choices, skipped ancestors, type-change refusal, revision/key/account/root binding, cancelled runs and post-transfer tree verification.
- **314 headless interface checks passed**: the existing 300 plus 14 saved-pair/FTP recovery cases. These use production renderers with synthetic bridges. New coverage includes protocol-bound recovery, exact deletion choices, root-path conflicts, manual-only type conflicts, load/forget behavior, late replies, refreshed revisions and narrow light/dark layouts. Wide and narrow screenshots were visually inspected.
- Four single-instance unit tests passed. Native CI additionally launches a second Electron process to verify rejection and continued primary IPC; that native result is pending.
- Renderer builds, syntax checks and diff validation passed. Production dependency audit found zero vulnerabilities.

Independent review corrected a bounded-read race in baseline storage, final staging-file identity validation, misleading upload-offset/cleanup labels and a checkbox layout issue. The first complete suite exposed a timing-sensitive pause fixture: polling could observe a fully received file. It now pauses synchronously at the first payload event and asserts a nonempty, incomplete prefix. All 12 cases across four concurrent repeat processes passed, followed by the successful 611-test full suite. Production timing limits were not weakened.

## Platform and publication gates

Native Linux IPC checks, source CI and installer packaging for both Macs, Windows and Linux are pending. New native cases cover FTP upload and folder recovery, saved synchronization across reconnects, skipped conflicts, permanent deletion decline/approval, baseline removal and second-instance protection. No v0.17 release is claimed until these gates and public artifact verification pass.

## Evidence boundaries

Tests use temporary local files and controlled loopback servers. Native smoke uses real Electron/preload routing with synthetic credentials and injected native confirmation replies. Positive OS credential unlocking, interactive installed-package behavior, external-server interoperability and complete SecureFX parity remain unverified. No Electron window is launched on the development laptop.

Saved synchronization is SFTP-only, explicit and not resumable. FTP/FTPS recovery preserves staging files and backups when forgotten. Folder and deletion workflows are sequences of changes, not atomic transactions; completed changes remain after failure. Stale synchronization storage locks require manual inspection after a process crash. macOS packages remain unnotarized and Windows packages unsigned.
