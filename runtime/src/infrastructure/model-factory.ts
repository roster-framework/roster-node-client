import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { initChatModel } from "langchain/chat_models/universal";
import { ModelParameters, type ManagedAgentConfig } from "@roster/contracts";

export function modelOptions(config: ManagedAgentConfig) {
  return ModelParameters.parse(config.model_parameters ?? {});
}
// Keep the existing synchronous entry point for built-in providers.
export function managedModel(config: ManagedAgentConfig, apiKey: string) {
  const options = modelOptions(config);
  if (config.provider === "anthropic")
    return new ChatAnthropic({
      maxTokens: 4096,
      maxRetries: 1,
      ...options,
      model: config.model,
      apiKey,
      ...(config.base_url !== 'https://api.openai.com/v1' ? {anthropicApiUrl:config.base_url} : {}),
    });
  if (!["openai", "openai-compatible"].includes(config.provider))
    throw new Error(
      "Use the asynchronous model factory for installed provider integrations",
    );
  return new ChatOpenAI({
    maxRetries: 1,
    ...options,
    model: config.model,
    apiKey,
    configuration: { baseURL: config.base_url },
  });
}
export async function createManagedModel(
  config: ManagedAgentConfig,
  apiKey?: string,
) {
  if (["openai-compatible", "openai", "anthropic"].includes(config.provider))
    return managedModel(config, apiKey || "roster-local-no-key");
  // Provider registry belongs to LangChain; model IDs never require Roster edits.
  return initChatModel(config.model, {
    maxRetries: 1,
    ...modelOptions(config),
    modelProvider: config.provider,
    configurableFields: [],
    ...(apiKey ? { apiKey } : {}),
    ...(config.provider === "ollama" ? { baseUrl: config.base_url } : {}),
  });
}
