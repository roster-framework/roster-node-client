"""Translate a runtime model binding into the selected SDK's model interface."""
import os


def model_binding(config, validation=False):
    provider = config["provider"]
    model = config["model"]
    if not model:
        raise ValueError("Model ID required")
    options = dict(config.get("model_parameters") or {})
    env = config["credential_env"]
    key = os.environ.get(env) if env else None
    if env and not key and not validation:
        raise ValueError("Model credential environment not configured")
    if validation and env and not key:
        key = "roster-constructor-validation"
    return provider, model, options, key


def langchain_model(config, validation=False):
    from langchain.chat_models import init_chat_model
    provider, model, options, key = model_binding(config, validation)
    if provider == "openai-compatible":
        provider = "openai"
        options["base_url"] = config["base_url"]
        key = key or "roster-local-no-key"
    elif provider == "ollama":
        options["base_url"] = config["base_url"]
    if key:
        options["api_key"] = key
    # Explicit provider; model names never infer a different endpoint/provider.
    return init_chat_model(model, model_provider=provider, configurable_fields=None, **options)


def crewai_model(config, validation=False):
    from crewai import LLM
    provider, model, options, key = model_binding(config, validation)
    if provider == "openai-compatible":
        options["base_url"] = config["base_url"]
        options["custom_openai"] = True
        provider = "openai"
        key = key or "roster-local-no-key"
    elif provider == "ollama":
        options["base_url"] = config["base_url"]
    if key:
        options["api_key"] = key
    # CrewAI/LiteLLM expects provider/model; do not accidentally double-prefix.
    identifier = model if model.startswith(provider + "/") else provider + "/" + model
    return LLM(model=identifier, **options)
