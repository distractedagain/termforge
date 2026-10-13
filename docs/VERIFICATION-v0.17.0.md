# ForgeCRT 0.17.0 verification

Status: all source, native Linux and four-platform packaging gates passed. Publication and public-asset verification are pending.

## Scope

FTP, explicit FTPS and implicit FTPS folder copy/merge and durable file/folder recovery; persistent SFTP two-way content baselines with reviewed deletion propagation, saved pair selection, root loading and explicit baseline removal.

## Local evidence

- Complete backend suite: **611 passed**, zero failures/skips, with bounded test concurrency.
- FTP coverage: **55 protocol, recovery and adversarial tests**, using real loopback FTP and explicit/implicit FTPS. Cases include REST/APPE suffixes, restart recovery, completed-child receipts, reviewed merges, changed sources/targets, trusted certificate rotation, ignored/refused REST, refused APPE, lost completion/mkdir/rename acknowledgements, stage substitution, unsafe journals, shutdown and depth limits.
- Persistent synchronization: 16 new folder/wire cases plus 11 storage/adversarial cases cover consecutive generations, changes on either side, file/subtree/root deletion, conflict choices, skipped ancestors, type-change refusal, revision/key/account/root binding, cancelled runs and post-transfer tree verification.
- **314 headless interface checks passed**: the existing 300 plus 14 saved-pair/FTP recovery cases. These use production renderers with synthetic bridges. New coverage includes protocol-bound recovery, exact deletion choices, root-path conflicts, manual-only type conflicts, load/forget behavior, late replies, refreshed revisions and narrow light/dark layouts. Wide and narrow screenshots were visually inspected.
- Four single-instance unit tests passed. Native Linux additionally launched a second Electron process and verified rejection with continued primary IPC.
- Renderer builds, syntax checks and diff validation passed. Production dependency audit found zero vulnerabilities.

Independent review corrected a bounded-read race in baseline storage, final staging-file identity validation, the storage-commit uncertainty documentation, misleading upload-offset/cleanup labels and a checkbox layout issue. The first complete suite exposed a timing-sensitive pause fixture: polling could observe a fully received file. It now pauses synchronously at the first payload event and asserts a nonempty, incomplete prefix. All 12 cases across four concurrent repeat processes passed, followed by the successful 611-test full suite. Production timing limits were not weakened.

## Platform and native evidence

All four [source CI jobs](https://github.com/distractedagain/termforge/actions/runs/38483124961) and [installer builds](https://github.com/distractedagain/termforge/actions/runs/38483144173) passed at source `ccb8aa3340b024225c45111a3a1919a34dea6eaf`.

| Platform | Backend tests passed | Expected skips | Failures |
| --- | ---: | ---: | ---: |
| macOS Apple Silicon | 611 | 0 | 0 |
| macOS Intel | 611 | 0 | 0 |
| Linux x64 | 611 | 0 | 0 |
| Windows x64 | 592 | 19 | 0 |

Linux passed all 314 headless interface checks and seven localhost Ansible checks. Both Macs also passed the seven Ansible checks. Production audits reported zero vulnerabilities, and both macOS packages passed strict ad-hoc signature integrity verification.

Native Linux Electron verified persistent synchronization across reconnects, inferred changes in both directions, skipped conflicts remaining conflicts, exact permanent deletion decline/approval, baseline-only removal, FTP upload append recovery, reviewed folder download recovery with retained completed children, REST recovery and the single-instance lock. Existing native host/certificate checks, authentication, transfer, editor, menu, PTY and storage-identity checks also passed. Native confirmations use injected replies, not human dialog interaction.

## Publication

The eight installers/archives and four build records passed packaging at the source above. The verified publisher and anonymous public release checks remain pending; no public v0.17 release is claimed here yet. The source tag will remain bound to the tested build commit; later documentation-only corrections and verification results may appear on main.

## Evidence boundaries

Tests use temporary local files and controlled loopback servers. Native smoke uses real Electron/preload routing with synthetic credentials and injected native confirmation replies. Positive OS credential unlocking, interactive installed-package behavior, external-server interoperability and complete SecureFX parity remain unverified. No Electron window is launched on the development laptop.

Saved synchronization is SFTP-only, explicit and not resumable. FTP/FTPS recovery preserves staging files and backups when forgotten. Folder and deletion workflows are sequences of changes, not atomic transactions; completed changes remain after failure. Stale synchronization storage locks require manual inspection after a process crash. macOS packages remain unnotarized and Windows packages unsigned.
