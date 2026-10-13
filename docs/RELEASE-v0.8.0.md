TermForge 0.8.0 adds a local project workspace so automation files can be edited, reviewed and run beside terminal sessions. It combines a bundled Monaco editor, read-only Git review, private file history and explicitly reviewed Ansible execution. TermForge remains free and MIT-licensed for macOS, Windows and Linux.

This remains a preview. Complete SecureCRT feature coverage, real WSL/device integration and packaged interactive verification remain in development.

## Project editing and review

- Open a local folder and work in file tabs with search, YAML diagnostics and Ansible snippets, JSON language services, and Python/Jinja editing. Opening the folder runs no project code.
- Keep terminal sessions visible beneath the editor without reconnecting them.
- Review Git branch/status and staged or unstaged diffs. Git integration does not stage, commit, fetch or push.
- Save with revision checks so an external edit cannot be silently overwritten. Existing-file saves retain up to twenty private backup versions outside the project; History shows a diff before restore/save.
- Ask AI for a whole-file proposal, review the completed reply as a diff, apply it to the editor and save separately. Proposals never start terminal commands or Ansible jobs.
- Native clipboard writes acknowledge completion after the underlying operation finishes, keeping editor copy/paste ordered correctly.

The editor accepts bounded UTF-8 text files up to 2 MiB and excludes symlink paths and `.git` contents. Git review requires the selected folder to be a repository root; linked worktrees, submodules and executable Git configuration are excluded. See the [project workspace guide](https://github.com/distractedagain/termforge/blob/main/docs/PROJECT-WORKSPACE.md).

## Ansible workflow

Choose a saved playbook and inventory, controller, target limit and mode. Trust the project, review the prepared command, then start **Syntax**, **Check + diff** or **Run**. The reviewed playbook and inventory are checked again before launch; changes invalidate the review. Task/host results, supported diffs, final status and cancellation appear in the workspace.

Ansible Core and Runner must be installed separately in a compatible Python environment. macOS and Linux use a local controller; Windows uses a controller inside WSL. Vendor collections are also installed separately. TermForge does not install runtimes or collections automatically.

Trusted Ansible projects can execute code through configuration, plugins, inventory and roles, including during syntax or check mode. Check mode depends on module support and can be overridden by tasks. Included files and external sources are not an immutable snapshot. Cancellation stops the owned controller workflow; it does not roll back completed changes or guarantee that remote operations have stopped.

## AI and existing terminal workflows

Local Ollama and the OpenRouter free router remain available. File attachment is explicit, online sending still requires consent, and quota failures do not switch to paid models. Whole-file application is disabled if attachment redaction changed possible secrets or the captured file/buffer has changed. See the [AI Assistant guide](https://github.com/distractedagain/termforge/blob/main/docs/AI-ASSISTANT.md).

Saved sessions, tab groups, snapshots, color schemes, command review, transfers and Python automation remain available. This is a focused automation editor; it does not include a VS Code extension host, debugger, remote controller, scheduled jobs or device-independent rollback.

## Verification and distribution status

The local source passed **200/200 backend tests** with no skips, **97/97 existing interface checks**, **13/13 project interface checks**, and **7/7 real localhost Ansible integration checks**. The interface runs recorded no browser errors. The localhost run used Python 3.14.8, Ansible Core 2.21.5 and Runner 2.4.3. It covered availability, syntax, check/diff without the fixture write, an explicit temporary-file write and host statistics, changed-input rejection, task failure and cancellation.

Project interface checks use real temporary files/Git with synthetic AI and Ansible events. They cover editor saves/conflicts, history restoration, Git review, editor clipboard actions, reviewed AI proposals, run confirmation/cancellation controls, local JSON diagnostics and compact/light layouts.

All four [CI jobs](https://github.com/distractedagain/termforge/actions/runs/38342881401) and all four [packaging jobs](https://github.com/distractedagain/termforge/actions/runs/38342904453) succeeded at source `c2d00e3c9284a6c304f821cf2698a50f46dce847`; packaging passed on its first attempt. Both Macs and Linux passed 200 backend tests each plus 7 real localhost Ansible checks. Windows passed 195 backend tests with five expected platform-specific skips. Both Mac packages passed strict recursive ad-hoc signature verification.

[Linux CI](https://github.com/distractedagain/termforge/actions/runs/38342881401) also passed 97 interface, 13 project and 7 real localhost checks, followed by a real Electron source-app smoke. It verified clipboard IPC completion, YAML/JSON saves, the custom-protocol JSON worker (10 messages, zero worker errors), zero CSP violations and no terminal writes from editor actions. Both desktop and editor PNG captures succeeded. The smoke retains real PTY and isolated loopback SSH coverage; folder-selection results are stubbed rather than exercised through the OS picker.

No Electron window was launched on the development laptop. The Linux Electron result applies to the source app, not an installed release package. Real WSL, network-device collections, live AI inference and packaged interactive desktop behavior remain unverified.

Package targets remain macOS ARM64/Intel DMG and ZIP, Windows x64 Setup/portable EXE, and Linux x64 AppImage/DEB. The existing signing setup uses macOS ad-hoc signatures without Apple notarization; Windows packages are unsigned. SSH/SFTP require installed system clients. Python, Ansible, local AI models and online API keys are not bundled. The publisher validates package checksums and platform build records before making this preview public.
