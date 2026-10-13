"""Original ForgeCRT Python bridge; no third-party scripting engine."""

import builtins
import json
import os
import runpy
import sys
import threading
import types


_protocol_input = sys.stdin
_protocol_output = sys.stdout
_config = json.loads(_protocol_input.readline())
_prefix = _config["prefix"]
_lock = threading.RLock()
_request_id = 0


def _frame(value):
    _protocol_output.write(_prefix + json.dumps(value, ensure_ascii=True) + "\n")
    _protocol_output.flush()


def _rpc(method, **params):
    global _request_id
    with _lock:
        _request_id += 1
        request_id = _request_id
        _frame({"kind": "request", "requestId": request_id,
                "method": method, "params": params})
        line = _protocol_input.readline()
        if not line:
            raise RuntimeError("ForgeCRT closed the scripting bridge.")
        response = json.loads(line)
        if response.get("kind") != "response" or response.get("requestId") != request_id:
            raise RuntimeError("Invalid ForgeCRT scripting response.")
        if not response.get("ok"):
            raise RuntimeError(response.get("error", "ForgeCRT scripting request failed."))
        return response.get("result")


def _strings(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return list(value)
    raise TypeError("Expected a string or list/tuple of strings.")


class _Screen:
    __slots__ = ("_context_id", "_synchronous", "_match_index")

    def __init__(self, context_id=None):
        self._context_id = context_id
        self._synchronous = False
        self._match_index = 0

    def _call(self, method, **params):
        return _rpc(method, contextId=self._context_id, **params)

    @property
    def Rows(self):
        return self._call("screen.metadata", property="rows")

    @property
    def Columns(self):
        return self._call("screen.metadata", property="columns")

    @property
    def CurrentRow(self):
        return self._call("screen.metadata", property="currentRow")

    @property
    def CurrentColumn(self):
        return self._call("screen.metadata", property="currentColumn")

    def Get(self, startRow, startColumn, endRow, endColumn):
        return self._call("screen.get", startRow=startRow, startColumn=startColumn,
                          endRow=endRow, endColumn=endColumn)

    @property
    def Synchronous(self):
        return self._synchronous

    @Synchronous.setter
    def Synchronous(self, value):
        if not isinstance(value, bool):
            raise TypeError("Synchronous must be a boolean.")
        self._call("screen.synchronous", value=value)
        self._synchronous = value

    @property
    def MatchIndex(self):
        return self._match_index

    def Send(self, text):
        if not isinstance(text, str):
            raise TypeError("Send requires a string.")
        self._call("screen.send", data=text)

    def _wait(self, strings, timeout, ignore_case):
        result = self._call("screen.wait", strings=_strings(strings), timeout=timeout,
                            ignoreCase=ignore_case)
        self._match_index = result["index"]
        return result

    def WaitForString(self, text, timeout=0, bCaseInsensitive=False):
        if not isinstance(text, str):
            raise TypeError("WaitForString requires a string.")
        return self._wait(text, timeout, bCaseInsensitive)["index"] != 0

    def WaitForStrings(self, strings, timeout=0, bCaseInsensitive=False):
        return self._wait(strings, timeout, bCaseInsensitive)["index"]

    def ReadString(self, strings, timeout=0, bCaseInsensitive=False):
        return self._wait(strings, timeout, bCaseInsensitive)["data"]


class _Session:
    __slots__ = ("_context_id",)

    def __init__(self, context_id=None):
        self._context_id = context_id

    def _call(self, method, **params):
        return _rpc(method, contextId=self._context_id, **params)

    @property
    def Connected(self):
        return self._call("session.connected")

    def Disconnect(self):
        self._call("session.disconnect")

    def Connect(self, saved_session):
        self._call("session.connect", name=saved_session)

    def ConnectInTab(self, saved_session):
        result = self._call("session.connectInTab", name=saved_session)
        return crt._tab_for(result["contextId"])


class _Arguments:
    __slots__ = ("_arguments",)

    def __init__(self, arguments):
        self._arguments = tuple(arguments)

    @property
    def Count(self):
        return len(self._arguments)

    def GetArg(self, index):
        if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= self.Count:
            raise IndexError("Script argument index is outside the supplied arguments.")
        return self._arguments[index]


class _Tab:
    __slots__ = ("_context_id", "Screen", "Session")

    def __init__(self, screen, session, context_id=None):
        self._context_id = context_id
        self.Screen = screen
        self.Session = session

    def _call(self, method):
        return _rpc(method, contextId=self._context_id)

    @property
    def Index(self):
        return self._call("tab.index")

    @property
    def Caption(self):
        return self._call("tab.caption")

    def Activate(self):
        self._call("tab.activate")

    def Close(self):
        self._call("tab.close")

    def Clone(self):
        result = self._call("tab.clone")
        return crt._tab_for(result["contextId"])


class _CRT(types.ModuleType):
    def __init__(self):
        super().__init__("crt", "ForgeCRT's documented subset of terminal scripting APIs.")
        context_id = _config["defaultContextId"]
        self.Screen = _Screen(context_id)
        self.Session = _Session(context_id)
        self.Arguments = _Arguments(_config.get("arguments", []))
        self._tab = _Tab(self.Screen, self.Session, context_id)
        self._tabs = {context_id: self._tab}

    def _tab_for(self, context_id):
        if context_id not in self._tabs:
            self._tabs[context_id] = _Tab(_Screen(context_id), _Session(context_id), context_id)
        return self._tabs[context_id]

    def GetScriptTab(self):
        return self._tab

    def GetTabCount(self):
        return _rpc("tabs.count")

    def GetTab(self, index):
        result = _rpc("tabs.get", index=index)
        return self._tab_for(result["contextId"])

    def GetActiveTab(self):
        result = _rpc("tabs.active")
        return self._tab_for(result["contextId"])

    def Sleep(self, milliseconds):
        _rpc("sleep", milliseconds=milliseconds)


crt = _CRT()
sys.modules["crt"] = crt
builtins.crt = crt
_filename = os.path.abspath(sys.argv[1])
sys.argv = [_filename] + list(_config.get("arguments", []))
sys.path.insert(0, os.path.dirname(_filename))
_frame({"kind": "ready"})
runpy.run_path(_filename, init_globals={"crt": crt}, run_name="__main__")
