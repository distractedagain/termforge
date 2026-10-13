"""TermForge's private, JSONL Ansible controller. Never imported by a project."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time

OUTPUT_LOCK = threading.Lock()
CANCEL = threading.Event()
LIMIT_ERROR = None
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_FILES = 1024


def emit(value):
    with OUTPUT_LOCK:
        sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def clean_environment():
    allowed = {key: value for key, value in os.environ.items() if key in (
        "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SSH_AUTH_SOCK")}
    os.environ.clear()
    os.environ.update(allowed)
    os.environ["PATH"] = str(Path(sys.executable).parent) + os.pathsep + allowed.get("PATH", os.defpath)
    os.environ["PYTHONUNBUFFERED"] = "1"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["ANSIBLE_NOCOLOR"] = "1"
    os.environ["ANSIBLE_HOST_KEY_CHECKING"] = "True"


def probe(config):
    clean_environment()
    config = Path(config).resolve(strict=True)
    os.chdir(config.parent)
    os.environ["ANSIBLE_CONFIG"] = str(config)
    try:
        import ansible_runner  # noqa: F401 - verify this interpreter can import Runner
        import ansible.release
        if not shutil.which("ansible-playbook"):
            raise RuntimeError("ansible-playbook is missing from the selected Python environment")
        emit({"available": True, "runnerVersion": importlib.metadata.version("ansible-runner"),
              "ansibleVersion": ansible.release.__version__, "pythonVersion": sys.version.split()[0]})
        return 0
    except Exception as error:
        emit({"available": False, "error": str(error)[:8192], "pythonVersion": sys.version.split()[0],
              "hint": "Install ansible-core and ansible-runner in this Python environment. On Windows use a Python environment inside WSL. TermForge never installs packages automatically."})
        return 1


def process_start(pid):
    return subprocess.check_output(["ps", "-p", str(pid), "-o", "lstart="], text=True, timeout=2).strip()


def process_table():
    output = subprocess.check_output(["ps", "-A", "-o", "pid=,ppid="], text=True, timeout=2)
    return [(int(parts[0]), int(parts[1])) for line in output.splitlines()
            if len(parts := line.split()) == 2 and all(part.isdecimal() for part in parts)]


def process_alive(pid, started):
    try:
        if process_start(pid) != started:
            return False
        state = subprocess.check_output(["ps", "-p", str(pid), "-o", "stat="], text=True, timeout=2).strip()
        return bool(state) and not state.startswith("Z")
    except subprocess.CalledProcessError:
        return False


def stop_tree(directory):
    """Terminate only the recorded controller and its current descendants."""
    metadata = Path(directory) / "controller.json"
    if not metadata.exists():
        raise RuntimeError("Controller process identity has not been recorded")
    info = json.loads(metadata.read_text(encoding="utf-8"))
    pid = info.get("pid")
    if not isinstance(pid, int) or pid <= 1 or pid == os.getpid():
        raise RuntimeError("Invalid controller process identity")
    try:
        if process_start(pid) != info["started"]:
            raise RuntimeError("Controller process identity changed; refusing to signal it")
    except subprocess.CalledProcessError:
        return 0  # The recorded controller already exited.
    targets = [pid]
    table = process_table()
    for _ in range(len(table) + 1):
        added = [child for child, parent in table if parent in targets and child not in targets]
        if not added:
            break
        targets.extend(added)
    identities = {}
    for target in targets:
        try:
            identities[target] = process_start(target)
        except subprocess.CalledProcessError:
            pass
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for target in reversed(targets):
            try:
                if process_start(target) == identities.get(target):
                    os.kill(target, sig)
            except (ProcessLookupError, subprocess.CalledProcessError):
                pass
        if sig == signal.SIGTERM:
            time.sleep(0.5)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if not any(process_alive(target, started) for target, started in identities.items()):
            return 0
        time.sleep(0.05)
    raise RuntimeError("Controller descendants remained alive after termination")


def validate_file(root, item):
    relative = item.get("path", "")
    value = Path(relative)
    if not relative or value.is_absolute() or any(part in ("..", ".git") for part in value.parts):
        raise RuntimeError("Invalid reviewed project path")
    target = root / value
    current = root
    for part in value.parts:
        current = current / part
        if current.is_symlink():
            raise RuntimeError("Reviewed Ansible input became a symbolic link")
    real = target.resolve(strict=True)
    if root not in real.parents or not real.is_file() or real.stat().st_size > 2 * 1024 * 1024:
        raise RuntimeError("Reviewed Ansible input is not a bounded project file")
    with real.open("rb") as stream:
        data = stream.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != item.get("revision"):
        raise RuntimeError(f"{relative} changed after review. Save and prepare again.")
    return real


def artifact_limit(directory):
    total = count = 0
    for root, directories, files in os.walk(directory, followlinks=False):
        directories[:] = [name for name in directories if not Path(root, name).is_symlink()]
        for name in files:
            try:
                stat = Path(root, name).lstat()
                total += stat.st_size
                count += 1
                if total > MAX_ARTIFACT_BYTES or count > MAX_ARTIFACT_FILES:
                    return True
            except FileNotFoundError:
                pass
    return False


def sanitized_event(event):
    data = event.get("event_data") or {}
    data = data if isinstance(data, dict) else {}
    result = data.get("res") or {}
    result = result if isinstance(result, dict) else {}
    hidden = bool(result.get("_ansible_no_log") or data.get("no_log") or result.get("censored"))
    payload = {"type": "event", "event": str(event.get("event", ""))[:120],
               "host": str(data.get("host", ""))[:512], "task": str(data.get("task", ""))[:1024],
               "changed": result.get("changed") is True,
               "failed": event.get("event") in ("runner_on_failed", "runner_on_unreachable"),
               "message": "Output hidden by Ansible no_log." if hidden else str(event.get("stdout", ""))[:8192]}
    if not hidden and result.get("diff") is not None:
        payload["diff"] = json.dumps(result["diff"], ensure_ascii=True)[:16384]
    if event.get("event") == "playbook_on_stats":
        payload["stats"] = {key: data.get(key, {}) for key in ("ok", "changed", "failures", "dark", "skipped", "rescued", "ignored", "processed")}
    return payload


def run(request_path):
    global LIMIT_ERROR
    request_path = Path(request_path).resolve(strict=True)
    if request_path.stat().st_size > 65536:
        raise RuntimeError("Controller request is too large")
    config = json.loads(request_path.read_text(encoding="utf-8"))
    private = request_path.parent
    if private != Path(config["privateDirectory"]).resolve(strict=True):
        raise RuntimeError("Controller private directory does not match its request")
    root = Path(config["projectRoot"]).resolve(strict=True)
    if root == private or root in private.parents:
        raise RuntimeError("Controller artifacts cannot be placed inside the project")
    if config["mode"] not in ("syntax", "check", "run"):
        raise RuntimeError("Invalid Ansible mode")
    reviewed = {item["path"]: validate_file(root, item) for item in config["files"]}
    playbook = reviewed[config["playbook"]]
    inventory = reviewed[config["inventory"]]
    limit = config.get("limit", "")
    if not isinstance(limit, str) or len(limit) > 1024 or limit.startswith(("-", "@")) or any(char.isspace() or ord(char) < 32 for char in limit):
        raise RuntimeError("Invalid host limit")
    timeout = config.get("timeout", 3600)
    if not isinstance(timeout, int) or timeout < 1 or timeout > 86400:
        raise RuntimeError("Invalid controller timeout")
    os.umask(0o077)
    clean_environment()
    os.environ["ANSIBLE_LOCAL_TEMP"] = str(private / "tmp")
    os.environ["ANSIBLE_CACHE_PLUGIN"] = "memory"
    os.environ["ANSIBLE_RETRY_FILES_ENABLED"] = "False"
    os.chdir(root)
    (private / "controller.json").write_text(json.dumps({"pid": os.getpid(), "started": process_start(os.getpid())}), encoding="utf-8")
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: CANCEL.set())

    def listen():
        for line in sys.stdin:
            if len(line) > 4096:
                CANCEL.set()
                return
            try:
                if json.loads(line).get("type") == "cancel":
                    CANCEL.set()
            except (ValueError, AttributeError):
                CANCEL.set()
        CANCEL.set()  # The desktop vanished; never leave an unattended controller.

    done = threading.Event()
    started = time.monotonic()

    def monitor():
        global LIMIT_ERROR
        while not done.wait(0.2):
            if time.monotonic() - started > timeout or artifact_limit(private):
                LIMIT_ERROR = "Controller time or private-artifact limit exceeded (16 MiB / 1024 files)."
                CANCEL.set()
                return

    threading.Thread(target=listen, daemon=True).start()
    threading.Thread(target=monitor, daemon=True).start()

    def event_handler(event):
        emit(sanitized_event(event))
        return False  # Keep bounded UI events, not unbounded per-task artifact files.

    def status_handler(status, runner_config):
        value = status.get("status")
        if value in ("starting", "running"):
            emit({"type": "status", "status": value})

    try:
        import ansible_runner
        runner = ansible_runner.run(
            private_data_dir=str(private), project_dir=str(root), playbook=str(playbook), inventory=str(inventory),
            limit=limit or None, cmdline="--syntax-check" if config["mode"] == "syntax" else "--check --diff" if config["mode"] == "check" else "",
            artifact_dir=str(private / "artifacts"), ident="result", rotate_artifacts=1,
            quiet=True, suppress_env_files=True, fact_cache_type="memory", timeout=timeout,
            settings={"suppress_output_file": True, "suppress_ansible_output": True,
                      "job_timeout": timeout, "idle_timeout": 300, "pexpect_timeout": 1},
            event_handler=event_handler, status_handler=status_handler, cancel_callback=CANCEL.is_set)
        if LIMIT_ERROR:
            emit({"type": "error", "error": LIMIT_ERROR})
        status = "failed" if LIMIT_ERROR else "cancelled" if CANCEL.is_set() else "successful" if runner.rc == 0 and runner.status == "successful" else "failed"
        emit({"type": "status", "status": status, "rc": runner.rc})
        return 0 if status in ("successful", "cancelled") else 1
    finally:
        done.set()


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("--probe", "--run", "--stop"):
        raise RuntimeError("Invalid private controller invocation")
    return {"--probe": probe, "--run": run, "--stop": stop_tree}[sys.argv[1]](sys.argv[2])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        emit({"type": "error", "error": str(error)[:8192]})
        sys.exit(1)
