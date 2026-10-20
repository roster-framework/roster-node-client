"""Tools are local RPC stubs. The host retains MCP credentials and checks."""
from typing import Any
from pydantic import Field, create_model


def argument_schema(tool):
    schema = tool["schema"]
    required = set(schema.get("required", []))
    fields = {name: (Any, Field(default=... if name in required else None,
                               description=prop.get("description", "")))
              for name, prop in schema.get("properties", {}).items()}
    cls = create_model("ToolArguments", **fields)
    # Preserve full nested MCP schema for model discovery. The host validates
    # actual arguments against the original schema before invoking the tool.
    cls.model_json_schema = classmethod(lambda cls, **kwargs: schema)
    return cls


def langchain_tools(tools, invoke):
    from langchain_core.tools import StructuredTool
    def make(item):
        def call(**args):
            return invoke(item["name"], args)
        return StructuredTool(name=item["name"], description=item["description"] or item["name"],
                              args_schema=argument_schema(item), func=call)
    return [make(item) for item in tools]


def crewai_tools(tools, invoke):
    from crewai.tools import BaseTool
    def make(item):
        class RemoteTool(BaseTool):
            def _run(self, **kwargs):
                return invoke(item["name"], kwargs)
        return RemoteTool(name=item["name"], description=item["description"] or item["name"],
                          args_schema=argument_schema(item))
    return [make(item) for item in tools]
