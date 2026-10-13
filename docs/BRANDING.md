# ForgeCRT naming and storage compatibility

Starting with v0.16, the desktop product is **ForgeCRT**, formerly TermForge. It remains original MIT-licensed software independent of VanDyke Software. SecureCRT and SecureFX are reference products, not ForgeCRT components. The repository remains `https://github.com/distractedagain/termforge`.

The display name, app bundle, About/window/menu labels and published installers use ForgeCRT. The following identifiers deliberately remain stable:

- Package name and Linux executable: `termforge`; desktop file: `termforge.desktop`.
- Application identifier: `org.termforge.desktop`.
- Early Electron runtime application name: `TermForge`.
- Existing application-data location, with `TERMFORGE_DATA_DIR` and the older `HARBOR_DATA_DIR` overrides still recognized.
- `termforge://` application protocol, IPC names, configuration format, credential vault and recovery formats.
- Existing CI artifact names and source-repository links. Public v0.16 asset basenames use `ForgeCRT-0.16.0-…`.

Electron 44.7.0 derives the macOS safe-storage service/account and Linux password-store product/application names from the runtime application name. It loads the main script before configuring those stores. Keeping `app.setName('TermForge')` early therefore preserves the lookup names despite the new product label; see [Electron initialization](https://github.com/electron/electron/blob/v44.7.0/shell/browser/electron_browser_main_parts.cc#L597) and [application-name override](https://github.com/electron/electron/blob/v44.7.0/shell/browser/browser.cc#L196). Windows local encryption state also stays in the established application-data location.

This preserves the identifiers by construction. It does not prove every installed OS credential-store migration: renamed/ad-hoc bundles may prompt for renewed access, and native Keychain, DPAPI and secure-keyring unlocks require their own platform tests. ForgeCRT refuses an unavailable/insecure encryption backend and does not silently reset a vault that fails to decrypt. Keep the prior application and data until the renamed application has opened the expected profiles and unlocked the needed credentials successfully. Running both names against the same live data simultaneously is unsupported.
