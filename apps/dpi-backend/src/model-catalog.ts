// One live-probed lane per provider (2026-10-14). Catalog membership does not prove current entitlement.
export const curatedModels = [
  { provider: "google-gemini-cli", id: "gemini-4-argon", name: "Gemini 4 Argon", tier: "S", icon: "gemini.png" },
  { provider: "google-gemini-cli", id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", tier: "A", icon: "gemini.png" },
  { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol", tier: "S", icon: "openai.png" },
  { provider: "xai", id: "grok-4.7", name: "Grok 4.7", tier: "S", icon: "grok.png" },
  { provider: "zai-coding-cn", id: "glm-5.3", name: "GLM 5.3", tier: "A", icon: "zai.png" },
  { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", tier: "A", icon: "deepseek.png" },
] as const;

export const preferredModel = { provider: "google-gemini-cli", modelId: "gemini-4-argon" } as const;
