# AI Assistant

TermForge's optional assistant investigates terminal output, drafts commands and proposes edits to an explicitly attached project file. Open **View → AI Assistant** or the speech-bubble toolbar button. It follows a review workflow: choose the text to share, ask a question, review the answer, then choose whether to stage a command or apply a file proposal.

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

## Propose a project file edit (0.8 source)

1. Open a project and select the file to change. Choose **AI edit** in the project workspace.
2. Review the attached file preview and describe the requested change. The assistant receives only the explicit attachment and prompt, not the repository or neighboring files.
3. Send locally, or explicitly consent to sharing with the online provider. Existing model, key and quota rules apply.
4. After a complete fenced reply arrives, choose **Review file edit**. Inspect the original/proposed diff before applying it to the editor.
5. Review the edited buffer and save separately. Applying an AI proposal does not write the file or launch a command/playbook.

The proposal must still match the captured project, file, revision and editor text. Changing that context makes the proposal stale and blocks application. The assistant proposes a complete replacement file, so review deletions as well as additions. If automatic masking changed possible secrets in the attachment, whole-file application is disabled to avoid replacing real values with redaction markers. The 16,384-character context limit also applies to files; larger files cannot be attached whole.

Saved edits use the project workspace's external-change checks and private backup history. See [Project workspace](PROJECT-WORKSPACE.md) for file limits and the separate, explicitly trusted Ansible run workflow.

## Privacy and troubleshooting

Attachment capture masks common private-key blocks, authorization headers and password/token assignments. This is best-effort redaction, not a complete secret detector. The edited preview is exactly the context sent. OpenRouter and its selected model provider may retain submitted text according to their policies. Use local mode when the text must stay on your computer.

Local mode connects directly to `127.0.0.1` on the numeric Ollama port (11434 by default), follows no redirects and rejects cloud model aliases. Before sending your question, it requests model metadata to verify a local GGUF chat model. If the list is empty, install a model in Ollama; if verification fails, choose a supported local model. A local Ollama server is trusted software, so misleading server metadata cannot independently prove locality.

Online mode connects only to `https://openrouter.ai/api/v1/chat/completions`. An invalid key, rate limit, provider failure or exhausted allowance is reported without retrying or switching to paid inference. Wait, retry manually, or switch to an installed local model. The renderer has no network capability; the main process validates bounded requests and streams plain text to the panel. The model has no filesystem, terminal or Ansible execution tools; file edits use the user's separate review/apply/save controls.

Requests, output and timeouts are bounded. The prompt limit is 8,192 characters; attached context is 16,384; displayed output is 65,536. Large or malformed streams fail explicitly. Cancel stops the active request and ignores late events.

## Verification scope

Backend tests use isolated loopback Ollama fixtures and synthetic HTTPS/SSE responses. Headless UI tests use synthetic terminal sessions, verify explicit context sharing and cloud consent, and exercise command review, target changes, cancellation, errors and secret clearing. They do not establish live model quality, provider account eligibility, actual quota availability or packaged desktop behavior. No user API key or real terminal output is used in these tests.

The local 0.8 source passed **200/200 backend tests** with no skips, **97/97 existing interface checks**, **13/13 project interface checks**, and **7/7 real localhost Ansible integration checks**. The interface runs recorded no browser errors. The project harness uses real temporary files with synthetic replies to check completed-response gating, diff review, separate apply/save and absence of an automatic Ansible launch. The localhost run used Python 3.14.8, Ansible Core 2.21.5 and Runner 2.4.3; it did not use AI inference or contact network devices.

No local Electron window was launched. Native CI results, including the configured Linux Electron worker/clipboard/save smoke, are pending. The smoke stubs OS folder selection. Live model inference, real WSL and packaged interactive behavior remain unverified; see [the interface verification report](UI-VERIFICATION.md).
