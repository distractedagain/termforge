TermForge 0.6.1 adds an optional AI Assistant to the free, MIT-licensed terminal client for macOS, Windows and Linux. Use local Ollama models or OpenRouter's free online router. This remains a preview; complete SecureCRT feature parity is still in development.

## AI investigation and command review

- Open **View → AI Assistant** or the speech-bubble toolbar button. Investigate a problem, explain output or draft a command.
- Explicitly attach selected terminal text or the visible screen. Review and edit the context before sending. Common secret patterns are masked, but review is still needed.
- Replies stream into the panel. Cancel stops generation; incomplete or failed replies cannot stage commands.
- **Use command** stages a completed suggestion in the Command Window with broadcast off. Sending requires reviewing the exact command and original terminal. Changing targets during review blocks the send.
- Nothing executes automatically. There is no autonomous diagnostic loop or claim that all suggested commands are harmless. Each question is independent; chat history is not saved or automatically resent.

## Free connections

**Ollama (local)** is the default. Install and start Ollama with a local GGUF chat model, then refresh the model list. TermForge connects directly to loopback and verifies local model metadata before sending text. Cloud aliases are excluded. Models are not bundled or downloaded automatically.

**Free online models (OpenRouter)** needs a free account and your own API key. The app uses only `openrouter/free`, applies zero price caps and disables paid fallback. Provider quotas and availability apply; if a free request cannot be served, it stops. Unlimited hosted usage and free ChatGPT/Claude API access are not included.

Online requests require explicit sharing permission. The selected text goes to OpenRouter and its model provider, whose retention policies apply. Keys stay in memory and are cleared when the panel closes or the connection changes. They are not saved to configuration, exports or browser storage.

See the [AI Assistant guide](https://github.com/distractedagain/termforge/blob/main/docs/AI-ASSISTANT.md) for setup, request limits and troubleshooting.

The 0.6.1 build also corrects the TFTP test client to handle legitimate retransmissions without accepting unexpected packets. The terminal implementation is unchanged by that fixture correction. Version 0.6.0 remains a source tag; its Intel Mac packaging encountered these fixture failures and no 0.6.0 installer release was published.

## Installation and verification

Packages cover macOS ARM64/Intel DMG and ZIP, Windows x64 Setup/portable EXE, and Linux x64 AppImage/DEB. macOS packages use ad-hoc signatures without Apple notarization; Windows packages are unsigned. SSH/SFTP require the installed system clients. Python automation requires Python 3. Neither Ollama nor an online API key is included.

Publication requires successful native backend tests, renderer builds and packaging on all four targets at the tagged source. The publisher verifies package hashes and source records before exposing eight binary packages, four build records and a combined SHA-256 manifest.

The local source passed **156 backend tests and 91 headless interface checks**, with zero failures and no browser console errors. AI backend tests use isolated local Ollama HTTP fixtures and synthetic online HTTPS/SSE responses. Headless interface checks use synthetic terminals and verify context opt-in, temporary keys, cancellation, command review, original-target checks and clipboard focus. Production dependency auditing reported no vulnerabilities at the development checkpoint.

No real online inference, user API key, installed local model or packaged interactive desktop was exercised for this feature. Passing fixtures verify application behavior, not answer quality or provider account availability. A local Electron window was not launched.
