"""Run the shipped bridge with a local author function, without a provider."""
import json
import runpy
import sys
import time
import types
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "python"))
from roster_agents import suspend_for_reply


def execute(request, invoke, log, record_usage=lambda _usage: None):
    mode = request["request"].get("mode", "valid")
    if mode in ("mixed", "double", "private", "failed", "abort"):
        frame = {"type": "suspend", "wait_id": "wait", "checkpoint": {"draft": "private-python-checkpoint"}}
        if mode == "private":
            frame["token"] = "private-token"
        sys.__stdout__.write(json.dumps(frame) + "\n")
        sys.__stdout__.flush()
        if mode == "abort":
            time.sleep(5)
        if mode == "failed":
            raise RuntimeError("private-provider-error")
        if mode != "double":
            return {"status": "ok", "summary": "must not complete", "output": "", "event": ""}
    checkpoint = {"draft": "private-python-checkpoint"}
    if mode == "oversized":
        checkpoint["draft"] = "x" * 65537
    try:
        suspend_for_reply("" if mode == "invalid" else "wait", checkpoint)
    finally:
        # Runtime can act only after author cleanup AND worker process exit.
        time.sleep(0.05)
        Path(request["workspace"], "worker-stopped").write_text("stopped")


engine = types.ModuleType("roster_agents.engines")
engine.execute = execute
engine.validate = lambda config: None
sys.modules["roster_agents.engines"] = engine
runpy.run_path(str(root / "python/roster_agents/worker.py"), run_name="__main__")
