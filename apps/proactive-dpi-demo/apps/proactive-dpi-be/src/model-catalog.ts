// Same four lanes Durable Pi probed on 2026-10-12. Catalog membership does not prove a credential.
export const curatedModels = [
  { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol", tier: "S", icon: "openai.png" },
  { provider: "xai", id: "grok-4.7", name: "Grok 4.7", tier: "S", icon: "grok.png" },
  { provider: "zai-coding-cn", id: "glm-5.3", name: "GLM 5.3", tier: "A", icon: "zai.png" },
  { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", tier: "A", icon: "deepseek.png" },
] as const;

export const preferredModel = { provider: "openai-codex", modelId: "gpt-6-sol" } as const;
export const defaultModelId = preferredModel.modelId;
