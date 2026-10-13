"""Bounded JSONL worker. Stdout is protocol-only; SDK console goes to stderr."""
import contextlib
import json
import os
import sys
from threading import Lock
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from roster_agents.engines import execute, validate
from roster_agents.suspension import SuspensionRequest

protocol = sys.stdout
protocol_lock = Lock()


def send(value):
    line = json.dumps(value, ensure_ascii=False)
    if len(line.encode("utf8")) > 1_000_000:
        raise ValueError("Bridge frame too large")
    with protocol_lock:
        protocol.write(line + "\n")
        protocol.flush()


def read():
    line = sys.stdin.buffer.readline(1_000_001)
    if not line.endswith(b"\n"):
        raise ValueError("Invalid bridge input")
    return json.loads(line)


def invoke(name, args):
    call_id = str(uuid4())
    send({"type": "tool", "id": call_id, "name": name, "args": args})
    result = read()
    if result.get("type") != "tool-result" or result.get("id") != call_id:
        raise ValueError("Tool rejected")
    return json.dumps(result.get("value"), ensure_ascii=False)


def main():
    # SDK telemetry is opt-out here: work content stays in configured providers.
    os.environ["OTEL_SDK_DISABLED"] = "true"
    os.environ["CREWAI_TELEMETRY_ENABLED"] = "false"
    os.environ["CREWAI_TRACING_ENABLED"] = "false"
    request = read()
    with contextlib.redirect_stdout(sys.stderr):
        if request["type"] == "validate":
            validate(request["config"])
            send({"type": "ready"})
        elif request["type"] == "execute":
            value = execute(request, invoke, lambda text: send({"type": "log", "text": text}),
                            lambda usage: send({"type": "model-usage", "value": usage}))
            send({"type": "result", "value": value})
        else:
            raise ValueError("Invalid request")


if __name__ == "__main__":
    try:
        main()
    except SuspensionRequest as request:
        # This is a private bridge request, never a public Runtime receipt.
        send({"type": "suspend", "wait_id": request.wait_id, "checkpoint": request.checkpoint})
    except Exception as error:
        # Provider exception strings may contain credentials or private input.
        code = "sdk_missing" if isinstance(error, ImportError) else "invalid_configuration" if isinstance(error, (ValueError, TypeError)) else "execution_failed"
        send({"type": "error", "code": code})
        sys.stderr.write("Roster Python worker failed\n")
        sys.exit(1)
