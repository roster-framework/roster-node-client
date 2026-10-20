"""Official framework loops, constrained to runtime-declared replies/tools."""
import json
from contextlib import contextmanager
from threading import Lock
from typing import Literal
from pydantic import create_model
from .models import langchain_model, crewai_model
from .tools import langchain_tools, crewai_tools


def reply_schema(config):
    return create_model("RosterReply", status=(Literal[tuple(config["statuses"])], ...),
                        summary=(str, ...), output=(str, ...),
                        event=(Literal[tuple(["", *config["events"]])], ...))


def published_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") in ("text", "output_text"))
    return ""


def validate(config):
    if config["engine"] == "langgraph-python":
        from langgraph.prebuilt import create_react_agent  # verify installed loop
        langchain_model(config, validation=True)
    elif config["engine"] == "crewai-python":
        from crewai import Agent, Task, Crew
        crewai_model(config, validation=True)
    else:
        raise ValueError("Unsupported Python engine")


def usage_report(config, key, phase, state, usage):
    # Normalize explicit SDK fields only; missing counts are never inferred.
    def count(value):
        return value if type(value) is int and 0 <= value <= 9007199254740991 else None

    input_tokens = count(usage.get("input_tokens"))
    cached = count(usage.get("cached_input_tokens"))
    if input_tokens is not None and cached is not None and cached > input_tokens:
        cached = None
    return {"version": 1, "invocation_id": key, "provider": config["provider"],
            "model": config["model"], "phase": phase, "state": state,
            "input_tokens": input_tokens, "output_tokens": count(usage.get("output_tokens")),
            "cached_input_tokens": cached}


@contextmanager
def crewai_usage(config, publish):
    from crewai.events import crewai_event_bus
    from crewai.events.types.llm_events import LLMCallCompletedEvent, LLMCallFailedEvent

    completed = set()
    failures = []
    lock = Lock()

    def record(_source, event):
        with lock:
            try:
                key = str(event.call_id)
                if key in completed:
                    return
                if len(completed) >= 1000:
                    raise ValueError("CrewAI usage report limit exceeded")
                completed.add(key)
                failed = isinstance(event, LLMCallFailedEvent)
                usage = {} if failed else event.usage or {}
                publish(usage_report(config, key, "unknown", "failed" if failed else "completed", {
                    "input_tokens": usage.get("prompt_tokens", usage.get("input_tokens")),
                    "output_tokens": usage.get("completion_tokens", usage.get("output_tokens")),
                    "cached_input_tokens": usage.get("cached_prompt_tokens"),
                }))
            except Exception:
                # The bus swallows handler errors. Keep a sticky safe failure
                # checked on the main execution path before terminal success.
                failures.append(True)

    for event_type in (LLMCallCompletedEvent, LLMCallFailedEvent):
        crewai_event_bus.on(event_type)(record)
    try:
        yield
    finally:
        try:
            if not crewai_event_bus.flush(timeout=30) or failures:
                raise RuntimeError("CrewAI usage delivery failed")
        finally:
            for event_type in (LLMCallCompletedEvent, LLMCallFailedEvent):
                crewai_event_bus.off(event_type, record)


def model_usage_callbacks(config, publish):
    from langchain_core.callbacks import BaseCallbackHandler

    class UsageCallback(BaseCallbackHandler):
        # A failed observation write must not silently become a successful run.
        raise_error = True
        run_inline = True

        def __init__(self):
            self.phases = {}
            self.completed = set()

        def on_chat_model_start(self, _serialized, _messages, *, run_id, metadata=None, **_kwargs):
            node = (metadata or {}).get("langgraph_node")
            self.phases[str(run_id)] = "final" if node == "generate_structured_response" else "loop" if node == "agent" else "unknown"

        def report(self, run_id, state, message=None):
            key = str(run_id)
            if key in self.completed:
                return
            self.completed.add(key)
            usage = getattr(message, "usage_metadata", None) or {}

            publish(usage_report(config, key, self.phases.pop(key, "unknown"), state, {
                "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"),
                "cached_input_tokens": (usage.get("input_token_details") or {}).get("cache_read"),
            }))

        def on_llm_end(self, response, *, run_id, **_kwargs):
            generations = response.generations
            generation = generations[0][0] if generations and generations[0] else None
            self.report(run_id, "completed", getattr(generation, "message", None))

        def on_llm_error(self, _error, *, run_id, **_kwargs):
            self.report(run_id, "failed")

    return UsageCallback()


def execute(request, invoke, log, record_usage=lambda _usage: None):
    config = request["config"]
    reply = reply_schema(config)
    user = json.dumps(request["request"], ensure_ascii=False)
    if config["engine"] == "langgraph-python":
        from langgraph.prebuilt import create_react_agent
        graph = create_react_agent(langchain_model(config),
                                   tools=langchain_tools(request["tools"], invoke),
                                   prompt=request["prompt"], response_format=(request["prompt"], reply))
        last = None
        result = None
        for state in graph.stream({"messages": [{"role": "user", "content": user}]},
                                  {"recursion_limit": 30, "callbacks": [model_usage_callbacks(config, record_usage)]}, stream_mode="values"):
            result = state.get("structured_response")
            messages = state.get("messages") or []
            message = messages[-1] if messages else None
            if message is not None and getattr(message, "type", "") == "ai":
                text = published_text(message.content)
                if text and text != last:
                    log(text[:20000])
                    last = text
        return reply.model_validate(result).model_dump()
    if config["engine"] == "crewai-python":
        from crewai import Agent, Task, Crew, Process
        agent = Agent(role="Task executor", goal="Complete the supplied task and return the declared result",
                      backstory=request["prompt"], llm=crewai_model(config), verbose=False,
                      allow_delegation=False, max_iter=30, tools=crewai_tools(request["tools"], invoke))
        task = Task(description=user, expected_output="RosterReply JSON with a declared status and local event",
                    agent=agent, output_pydantic=reply)
        with crewai_usage(config, record_usage):
            result = Crew(agents=[agent], tasks=[task], process=Process.sequential, verbose=False).kickoff()
        parsed = reply.model_validate(result.pydantic).model_dump()
        log(parsed["summary"][:20000])
        return parsed
    raise ValueError("Unsupported Python engine")
