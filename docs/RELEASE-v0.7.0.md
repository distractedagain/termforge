TermForge 0.7.0 refreshes the desktop interface with an original slate and teal design. It keeps the session management, terminal and AI workflows introduced in earlier previews while giving them clearer navigation, spacing and visual hierarchy. TermForge remains free and MIT-licensed for macOS, Windows and Linux.

This remains a preview; complete SecureCRT feature coverage and packaged interactive verification are still in development.

## Interface refresh

- A horizontal **Sessions / Commands / Active** manager switcher replaces the vertical manager labels.
- An original terminal app mark and consistent vector icons make the toolbar and connection controls easier to recognize.
- The welcome screen provides direct paths to a new connection, local shell or session import.
- Session lists, tabs, menus and dialogs use more space, clearer labels and rounded controls. The underlying terminal remains the focus of the workspace.
- The AI Assistant has a clearer provider badge, request controls, attached-context previews and command cards. Online sharing permission and provider disclosures remain visible in the form.
- Color Scheme cards and terminal previews have been refreshed. Light, dark and optional matching Solarized interface colors remain available.

See the [modern interface guide](https://github.com/distractedagain/termforge/blob/main/docs/MODERN-INTERFACE.md) for navigation and appearance settings.

## Existing workflows

Saved sessions, independent tab groups, resizable splits, workspace snapshots, the Command Window, transfer tools and automation remain available. This release changes the presentation of those workflows; it does not introduce autonomous AI execution or claim complete SecureCRT feature parity.

The AI Assistant continues to support local Ollama models and OpenRouter's free online router. Attaching terminal text is explicit. Online requests require sharing permission, and free-quota failures stop without switching to paid models. Completed command suggestions are staged for review against the original terminal before sending. See the [AI Assistant guide](https://github.com/distractedagain/termforge/blob/main/docs/AI-ASSISTANT.md).

## Installation and verification

[Download the v0.7.0 public preview](https://github.com/distractedagain/termforge/releases/tag/v0.7.0), including the checksum manifest and platform build records. The package targets remain macOS ARM64/Intel DMG and ZIP, Windows x64 Setup/portable EXE, and Linux x64 AppImage/DEB. macOS packages use ad-hoc signatures without Apple notarization; Windows packages are unsigned. SSH/SFTP require installed system clients, and Python automation requires Python 3. AI models and online API keys are not bundled.

The local source passed **156 backend tests and 97 headless interface checks**, with no failures or browser errors. Checks cover compact layouts, light/dark and matching palettes, keyboard access, reduced motion, reviewed AI commands and layout persistence across restart.

Headless interface checks use synthetic terminals and AI responses. They can verify layout, navigation and application behavior, but do not establish real model answer quality or provider account availability. No local Electron window was launched for this visual verification; packaged interactive desktop testing remains unverified.

## Publication evidence

Version 0.7.0 [native CI](https://github.com/distractedagain/termforge/actions/runs/38335309021), [packaging](https://github.com/distractedagain/termforge/actions/runs/38335319969), and [publication](https://github.com/distractedagain/termforge/actions/runs/38335846155) succeeded at tagged source `b2515479c65288e173fe6033b468d8233bbee258`. Both Mac architectures and Linux passed 156 backend tests each; Windows passed 153 with three expected POSIX-only skips. Linux passed 97 headless interface checks. All four package jobs passed on their first attempt. The twelve package/build-record files matched the checksum manifest; all thirteen public assets, including the manifest, matched GitHub's asset digests. Anonymous build-record downloads confirmed the tagged source. These results establish test and package provenance; live AI inference and packaged interactive behavior remain unverified.
