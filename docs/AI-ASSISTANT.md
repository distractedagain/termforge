# AI Assistant

TermForge's optional assistant investigates terminal output and drafts commands. Open **View → AI Assistant** or the speech-bubble toolbar button. It follows a review workflow: choose the output to share, ask a question, review the answer, then choose whether to send a suggested command.

## Free model connections

| Connection | Setup | Cost and limits |
| --- | --- | --- |
| Ollama (local; default) | Install [Ollama](https://ollama.com/) and a local chat model separately; start Ollama, then choose Refresh models | No hosted API fee. Uses your computer's memory, storage and processing power. TermForge downloads no models. |
| Free online models (OpenRouter) | Create a free [OpenRouter account and API key](https://openrouter.ai/settings/keys), choose Free online models, and paste the key into the masked field | Uses only `openrouter/free`. Free availability and quotas depend on OpenRouter. If unavailable or exhausted, the request stops. No paid fallback. |

Online mode uses OpenRouter's [Free Models Router](https://openrouter.ai/openrouter/free), which selects among available free models. It is not bundled access to ChatGPT or Claude. [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) and [Claude API billing](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage) are separate provider offerings; TermForge does not promise their paid models for free. OpenRouter's [rate limits](https://openrouter.ai/docs/api/reference/limits) can change.

TermForge fixes online requests to the free router, sets maximum prompt, completion, per-request and image prices to zero, disables provider fallbacks, and sends no paid plugins or tools. The app does not offer a paid model or top-up flow. These restrictions rely on OpenRouter honoring its documented [provider pricing controls](https://openrouter.ai/docs/guides/routing/provider-selection); a third-party free service is not guaranteed to remain available.

The OpenRouter key stays in memory while the panel is open. Closing the panel, switching connections or choosing Clear removes the key field and resets permission to send online. The key is not written to settings, exports, logs or browser storage. Closing the panel cancels active requests; it cannot recall text already received by a provider.

## Investigate an issue

1. Open the terminal you want to inspect. Choose a model connection in AI Assistant.
2. Select **Investigate**, **Explain output** or **Draft a command**, and enter your request. Include the device vendor and OS when syntax matters.
3. Optionally choose **Attach selection** or **Attach visible screen**. Review and edit the preview. A question without an attachment sends no terminal output, connection profile or hidden scrollback.
4. For online requests, enter your key and explicitly check **Send my prompt and attached text to OpenRouter and its model provider**. Choose **Send online**. Local requests use **Send**.
5. Review the answer. **Use command** places a completed command block into the Command Window with broadcast off. Review it there, press Send, and confirm the exact command and original terminal.

Suggestions never execute automatically. Switching tabs or closing the original terminal blocks sending that draft; switching during the confirmation also blocks it. A suggested command is not proof that the command is correct, harmless or supported by the connected device. There is no automatic read-only command allowlist or autonomous diagnostic loop in this version.

Attach output from the next diagnostic command for another question. Each request is independent; earlier responses and prompts are not automatically resent. Drafts, model replies and API keys are not saved as a chat transcript. Commands you explicitly send still participate in ordinary command history and any enabled input recording.

## Privacy and troubleshooting

Attachment capture masks common private-key blocks, authorization headers and password/token assignments. This is best-effort redaction, not a complete secret detector. The edited preview is exactly the context sent. OpenRouter and its selected model provider may retain submitted text according to their policies. Use local mode when the text must stay on your computer.

Local mode connects directly to `127.0.0.1` on the numeric Ollama port (11434 by default), follows no redirects and rejects cloud model aliases. Before sending your question, it requests model metadata to verify a local GGUF chat model. If the list is empty, install a model in Ollama; if verification fails, choose a supported local model. A local Ollama server is trusted software, so misleading server metadata cannot independently prove locality.

Online mode connects only to `https://openrouter.ai/api/v1/chat/completions`. An invalid key, rate limit, provider failure or exhausted allowance is reported without retrying or switching to paid inference. Wait, retry manually, or switch to an installed local model. The renderer has no network capability; the main process validates bounded requests and streams plain text to the panel. There are no AI tools with filesystem or terminal access.

Requests, output and timeouts are bounded. The prompt limit is 8,192 characters; attached context is 16,384; displayed output is 65,536. Large or malformed streams fail explicitly. Cancel stops the active request and ignores late events.

## Verification scope

Backend tests use isolated loopback Ollama fixtures and synthetic HTTPS/SSE responses. Headless UI tests use synthetic terminal sessions, verify explicit context sharing and cloud consent, and exercise command review, target changes, cancellation, errors and secret clearing. They do not establish live model quality, provider account eligibility, actual quota availability or packaged desktop behavior. No user API key or real terminal output is used in these tests.
