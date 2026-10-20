"""Author request only. Runtime attests suspension after this worker exits."""
import json
import re


class SuspensionRequest(BaseException):
    def __init__(self, wait_id, checkpoint):
        if not isinstance(wait_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", wait_id):
            raise ValueError("Invalid registered wait ID")
        if not isinstance(checkpoint, dict):
            raise ValueError("Checkpoint must be an object")
        raw = json.dumps(checkpoint, ensure_ascii=False, allow_nan=False)
        if len(raw.encode("utf8")) > 65536:
            raise ValueError("Checkpoint exceeds the limit")
        self.wait_id = wait_id
        self.checkpoint = json.loads(raw)
        super().__init__("Agent requested the registered reply wait")


def suspend_for_completion(wait_id, checkpoint):
    """Stop author execution; wait_id must already be registered with Core."""
    raise SuspensionRequest(wait_id, checkpoint)

# Compatibility name; both wait kinds use the same worker exit and journal.
suspend_for_reply = suspend_for_completion
