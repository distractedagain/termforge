# Python automation

TermForge runs a local `.py` file selected by the user with an installed Python 3 interpreter. The original TermForge bridge supplies a small `crt` API with familiar method names. This is an initial automation subsystem, not full SecureCRT script compatibility.

Scripts execute as ordinary local Python programs with the user's permissions. They can read or change local files, start other programs, and use the network through Python. Run scripts you trust. Python is not bundled. The default executable is `python3` on macOS/Linux and `python` on Windows; an absolute interpreter path can be supplied by the host integration. One script may run at a time. Cancelling stops the interpreter, and an unresponsive interpreter receives a forced termination after one second. Independently detached subprocesses started by a script are not managed by TermForge.

The script remains bound to the terminal selected when it starts, even when another tab becomes active. `crt.GetScriptTab().Screen` and `.Session` expose the same objects as `crt.Screen` and `crt.Session`. Scripts can obtain other actual terminal tabs through the tab collection. Each tab has its own screen and session context, and a Python tab reference remains usable after reconnecting its session. `crt` is available as a script global and as an importable module.

| API | TermForge behavior |
| --- | --- |
| `crt.Screen.Send(text)` | Writes text to the bound terminal. Use `\r` explicitly to send Enter. Maximum 256 KiB in UTF-8 per call. |
| `crt.Screen.WaitForString(text, timeout=0, bCaseInsensitive=False)` | Returns `True` on a match, `False` on timeout. Timeout is in seconds. |
| `crt.Screen.WaitForStrings(strings, timeout=0, bCaseInsensitive=False)` | Takes a string or list/tuple of strings. Returns the first matching string's one-based index, or zero on timeout. Matches the earliest occurrence in received text; ties use list order. |
| `crt.Screen.ReadString(strings, timeout=0, bCaseInsensitive=False)` | Returns received text preceding the matching delimiter, consuming the delimiter. On timeout it returns the buffered text received so far. |
| `crt.Screen.MatchIndex` | One-based index of the most recent wait/read match, or zero after timeout. |
| `crt.Screen.Synchronous` | Boolean, initially `False`. `True` retains newly received terminal output between waits; `False` retains output only during a pending wait. TermForge always displays terminal output immediately. |
| `crt.Screen.Get(startRow, startColumn, endRow, endColumn)` | Reads an inclusive rectangle from the terminal renderer's actual screen. Coordinates are one-based and must be inside the screen. This uses the host screen callback rather than the byte wait buffer. |
| `crt.Screen.Rows`, `.Columns`, `.CurrentRow`, `.CurrentColumn` | Reads actual dimensions and one-based cursor coordinates from the renderer through the host callback. Missing or invalid screen data raises an error. |
| `crt.Session.Connected` | Whether the bound terminal is open. For SSH, this does not establish that authentication succeeded; scripts must wait for the expected authenticated prompt. |
| `crt.Session.Disconnect()` | Closes the bound terminal. |
| `crt.Session.Connect(saved_session)` | Opens a saved profile by unique name, `folder/name`, profile ID, or `/S "folder/name"`. Disconnect first. Ad hoc protocol switches and passwords in command-line strings are not supported. |
| `crt.Session.ConnectInTab(saved_session)` | Opens the same saved-profile forms in a new terminal and returns its tab object. Keeps the script's bound terminal unchanged. |
| `crt.GetTabCount()`, `.GetTab(index)`, `.GetActiveTab()` | Reads the actual host terminal collection. Tab indices are one-based and follow the host's current ordering; they may change when tabs close or move. |
| `tab.Index`, `.Caption` | Reads the current index and title. Caption is read-only in this implementation. Title retrieval requires metadata from the host. |
| `tab.Activate()`, `.Close()`, `.Clone()` | Activates or closes that terminal. Clone opens another terminal using its actual session metadata or saved profile. Missing activation/close/profile callbacks raise explicit errors. |
| `crt.Sleep(milliseconds)` | Pauses the script while keeping cancellation responsive. |
| `crt.Arguments.Count`, `.GetArg(index)` | Reads arguments supplied by the host integration, with zero-based indices. `sys.argv` also includes these arguments. |

Waits operate on newly received terminal text from that tab's PTY/transport, including ANSI escape sequences. They do not read the rendered screen or scrollback; use `Get` for rendered screen text. The script-tab byte buffer begins when the script starts; another tab's buffer begins when the script first references that tab. Buffers do not include text displayed beforehand. Closing the referenced terminal raises `RuntimeError` for a pending wait. A zero/omitted timeout waits until a match, terminal closure, or cancellation; positive timeouts are capped at 24 hours. At most 64 nonempty wait strings may be supplied, each at most 16 KiB and together at most 128 KiB. Unconsumed terminal output is limited to 1 MiB per referenced tab; exceeding that limit stops the script with an explicit error instead of silently losing data. A script may reference at most 128 tab contexts.

Normal `print()` output and stderr are reported separately from internal requests. The bridge reserves stdin for its protocol, so `input()` and reading `sys.stdin` are not supported. `crt.Dialog`, Get2, IgnoreEscape, session configuration objects, VBScript/JScript, logon scripts, and SecureCRT-specific extension modules are not implemented. Unsupported properties such as `crt.Screen.IgnoreEscape` raise an error rather than pretending to work. Rendered screen access, tab collection, activation, captions, and cloning require actual callbacks supplied by the application; the backend never substitutes fabricated values when an integration is missing.

## Recorded input

The backend's `recordedInputToPython(events)` generates a Python script from explicitly collected input. It accepts strings or `{data, delayMs?}` objects; a delay is a pause before that send. Data is encoded as JSON and decoded in Python, so quotes, control characters and Unicode in a command cannot become Python statements. Recordings are bounded to 10000 events, 256 KiB per send, 1 MiB total input, 0–60000 ms per pause, and 24 hours of total pauses.

The application must make recording explicit and decide which input sources are recordable. The generator does not detect credentials or authenticated state. Generated scripts replay input and optional pauses, without deriving reliable prompt waits from timing. Review recorded commands and any sensitive content before saving or running a script. This generator alone does not establish UI recorder integration or full SecureCRT script recorder equivalence.

Example for an already open terminal:

```python
# $language = "Python3"
# $interface = "1.0"

crt.Screen.Synchronous = True
if not crt.Screen.WaitForString("lab-shell$ ", 10):
    raise RuntimeError("Expected authenticated shell prompt was not received")

crt.Screen.Send("pwd\r")
output = crt.Screen.ReadString("lab-shell$ ", 10)
if crt.Screen.MatchIndex == 0:
    raise RuntimeError("Command prompt was not received before timeout")
print(output)
```

This example is original TermForge code. Replace the full prompt and command with those appropriate for a terminal you intend to automate. A distinctive full prompt reduces false matches inside command output.

Public API names and the general send/wait/read model were reviewed against VanDyke's [scripting FAQ](https://www.vandyke.com/support/securecrt/scripting_faq.html), [ReadString tip](https://www.vandyke.com/support/tips/readstring.html), [tab scripting tip](https://www.vandyke.com/support/tips/tabscripts.html), and [scripting guide](https://www.vandyke.com/support/tips/scripting/index.html). The bridge implementation and example above are independently written.

Developer integration: `createAutomationManager()` takes callbacks for saved profiles, terminal open/close/write, active terminal ID, script output, and script status. `getTerminalIds()` returns an ordered array of IDs or `{id,title,profileId,session}` entries. Optional `getTerminalDetails(id)` supplies additional title/session metadata. `activateTerminal(id)` activates the actual tab. `getScreen({id,startRow?,startColumn?,endRow?,endColumn?})` returns `{text,rows,columns,currentRow,currentColumn}` from the actual terminal renderer; calls without a rectangle request metadata. Screen coordinates are checked in the backend and must also be validated against the live renderer.

Call `feedData({id, data})` for every terminal output event and `feedExit({id})` for terminal closure. `run({filename, terminalId?, pythonPath?, arguments?})` resolves `{id, terminalId}` after Python initializes; `cancel(id)` and `closeAll()` resolve after interpreter exit. Status events use `starting`, `running`, `completed`, `failed`, or `cancelled`; output events contain `{id, terminalId, stream, data}`. The temporary shim is copied out of Electron's ASAR and removed after interpreter exit. Host callbacks that await the renderer should have a timeout and reject when the renderer closes.
