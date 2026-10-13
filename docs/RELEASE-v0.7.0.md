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

The package targets remain macOS ARM64/Intel DMG and ZIP, Windows x64 Setup/portable EXE, and Linux x64 AppImage/DEB. macOS packages use ad-hoc signatures without Apple notarization; Windows packages are unsigned. SSH/SFTP require installed system clients, and Python automation requires Python 3. AI models and online API keys are not bundled.

The local source passed **156 backend tests and 97 headless interface checks**, with no failures or browser errors. Checks cover compact layouts, light/dark and matching palettes, keyboard access, reduced motion, reviewed AI commands and layout persistence across restart. Publication requires successful native backend tests, renderer builds and packaging on all four targets, plus verified source records and package checksums.

Headless interface checks use synthetic terminals and AI responses. They can verify layout, navigation and application behavior, but do not establish real model answer quality or provider account availability. No local Electron window or packaged interactive desktop is being launched for this visual verification.
