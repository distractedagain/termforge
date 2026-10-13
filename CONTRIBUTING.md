# Contributing

ForgeCRT welcomes improvements to its original, MIT-licensed implementation. Keep contributions independent: do not submit proprietary SecureCRT code, copied artwork, restricted documentation, or code obtained through license circumvention.

## Development

Use Node.js 24, npm, and the native build prerequisites in [README.md](README.md). Install with `npm ci`, run with `npm start`, and run `npm test` and `npm run build` before proposing a change. Package with `npm run dist` on the operating systems affected by your change when packaging or native terminal behavior changes.

Keep the change focused and describe its observable effect, why it is needed, and the verification performed. Separate verified behavior from assumptions. Name the platforms you actually tested; a cross-platform code path alone does not establish native runtime compatibility.

## Verification

Use synthetic session data and an SSH server you control. Useful manual checks include opening and closing local terminals, resizing tiled terminals, reconnecting, searching scrollback, importing session files, and accepting an expected new host fingerprint. Verify that an unexpected changed key is refused. For forwarding, test an explicitly permitted service on a local test host.

Run `npm run smoke` on a graphical desktop for the included native PTY and isolated loopback SSH checks. It needs `ssh` and `ssh-keygen` on PATH and launches your normal shell environment. Do not treat mocked launch-contract tests as evidence of a successful real connection on another operating system.

Command and broadcast changes need checks that the displayed targets match the actual recipients, cancelled confirmations send nothing, and closed terminals do not receive input. Logging changes need checks that logging is off by default, stopping it closes the file, and session closure cleans up the stream. Avoid adding tests that merely restate the implementation.

## Design and safety

- Keep privileged work in the Electron main process and expose narrow validated operations through preload.
- Pass SSH arguments as separate values; do not assemble a shell command from a hostname, username, or imported data.
- Preserve OpenSSH host-key verification and normal authentication prompts.
- Do not save secrets, quietly start logging, or send snippets without the required user action.
- Handle PTY closure, errors, resize limits, and dropped renderer windows without leaking processes.
- Treat imports, remote terminal output, filesystem paths, and configuration as untrusted input.
- Avoid telemetry or remote services without a clearly documented design and explicit user control.

A new protocol, credential vault, or scripting API needs a concrete design and threat review before implementation. Update [docs/FEATURES.md](docs/FEATURES.md) and the README when supported behavior changes. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

Submitting a contribution means you are authorized to license it under the project's MIT license. Preserve third-party attribution and license notices when adding dependencies.
