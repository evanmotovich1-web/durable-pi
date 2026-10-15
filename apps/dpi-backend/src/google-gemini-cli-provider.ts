import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  ApiStreamOptions,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  ModelAuth,
  OAuthCredential,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  calculateCost,
  clampThinkingLevel,
  createProvider,
  type Provider,
} from "@earendil-works/pi-ai/models";
import {
  convertMessages,
  convertTools,
  isThinkingPart,
  mapStopReasonString,
  mapToolChoice,
  retainThoughtSignature,
  retryGoogleRequest,
  supportsGoogleStrictToolSampling,
} from "@earendil-works/pi-ai/api/google-shared";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  getInitialSystemMessage,
} from "@earendil-works/pi-ai/utils/transcript";

const GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GEMINI_CLI_PROVIDER_NAME = "Google Cloud Code Assist (Gemini CLI)";
const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_USER_AGENT =
  "antigravity/cli/1.3.5 (aidev_client; os_type=darwin; arch=arm64; cl=998863838; auth_method=consumer)";
const DEFAULT_CONSUMER_PROJECT_ID = "aicode-consumers";
export const BRIDGE_MANAGED_TOKEN = "managed-by-official-cli";

export function geminiLoginBridgeScript(): string {
  return (
    process.env.GEMINI_LOGIN_BRIDGE ||
    join(homedir(), ".local/share/gemini-login-bridge/gemini_login_bridge.py")
  );
}

export function hasGeminiLoginBridge(): boolean {
  return existsSync(geminiLoginBridgeScript());
}

const rev = (s: string) => s.split("").reverse().join("");
const oauthHost = ["apps", "googleusercontent", "com"].join(".");

const getClientId = () => {
  if (process.env.PI_GEMINI_CLIENT_ID) return process.env.PI_GEMINI_CLIENT_ID;
  return ["1071006060591", "tmhssin2h21lcre235vtolojh4g403ep"].join("-") + "." + oauthHost;
};

const getClientSecret = () => {
  if (process.env.PI_GEMINI_CLIENT_SECRET) return process.env.PI_GEMINI_CLIENT_SECRET;
  return rev("fADq6z4CXs8BLm1JLdL684RWF85K-XPSC" + "OG");
};

const LEGACY_CLIENT_ID =
  ["681255809395", "oo8ft2oprdrnp9e3aqf6av3hmdib135j"].join("-") + "." + oauthHost;
const LEGACY_CLIENT_SECRET = rev("lxsFXlc5uC6Veg-kS7o1-mPMgHu4-XPSC" + "OG");

function normalizeConsumerProjectId(rawProjectId?: string): string {
  if (!rawProjectId || rawProjectId === "vibestudy-509202") {
    return DEFAULT_CONSUMER_PROJECT_ID;
  }
  return rawProjectId;
}

export async function refreshGoogleCloudToken(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const clientId =
    ((credential as Record<string, unknown>).clientId as string | undefined) || getClientId();
  const clientSecret =
    ((credential as Record<string, unknown>).clientSecret as string | undefined) ||
    getClientSecret();

  let response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credential.refresh,
      grant_type: "refresh_token",
    }),
    signal,
  });

  if (!response.ok && clientId !== LEGACY_CLIENT_ID) {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: LEGACY_CLIENT_ID,
        client_secret: LEGACY_CLIENT_SECRET,
        refresh_token: credential.refresh,
        grant_type: "refresh_token",
      }),
      signal,
    });
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Google Cloud token refresh failed (${response.status}): ${errorText || response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };

  const rawProjectId = (credential as Record<string, unknown>).projectId as string | undefined;

  return {
    ...credential,
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token || credential.refresh,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
    projectId: normalizeConsumerProjectId(rawProjectId),
  } as OAuthCredential;
}

let toolCallCounter = 0;

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function isGemini3Or4TieredModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("gemini-4-argon") ||
    lower.includes("gemini-3.8-flash") ||
    lower.includes("gemini-3-pro") ||
    lower.includes("gemini-3.1-pro")
  );
}

function getGoogleThinkingLevel(
  modelId: string,
  level: string,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
  if (isGemini3Or4TieredModel(modelId)) {
    switch (level) {
      case "minimal":
      case "low":
        return "LOW";
      case "medium":
        return "MEDIUM";
      default:
        return "HIGH";
    }
  }
  switch (level) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    default:
      return "HIGH";
  }
}

function getDisabledThinkingConfig(modelId: string): Record<string, unknown> {
  if (isGemini3Or4TieredModel(modelId)) {
    return { thinkingLevel: "LOW" };
  }
  if (modelId.toLowerCase().includes("gemini-3")) {
    return { thinkingLevel: "MINIMAL" };
  }
  return { thinkingBudget: 0 };
}

export function resolveBackendModelId(
  modelId: string,
  thinkingOpt?: { enabled?: boolean; level?: string },
): string {
  if (modelId === "gemini-4-argon" || modelId === "gemini-3.8-flash") {
    if (thinkingOpt && thinkingOpt.enabled === false) {
      return `${modelId}-low`;
    }
    const level = thinkingOpt?.level?.toUpperCase();
    if (level === "LOW" || level === "MINIMAL") {
      return `${modelId}-low`;
    }
    if (level === "MEDIUM") {
      return `${modelId}-medium`;
    }
    return `${modelId}-high`;
  }
  if (modelId === "gemini-3-flash-preview") {
    return "gemini-3-flash";
  }
  if (modelId === "gemini-3-pro-preview" || modelId === "gemini-3.1-pro-preview") {
    return "gemini-4-argon-high";
  }
  return modelId;
}

function resolveBridgeModelId(modelId: string): "gemini-4-argon" | "gemini-3.8-flash" | undefined {
  if (modelId.startsWith("gemini-4-argon")) return "gemini-4-argon";
  if (modelId.startsWith("gemini-3.8-flash")) return "gemini-3.8-flash";
  return undefined;
}

function resolveBridgeEffort(
  modelId: string,
  thinkingOpt?: { enabled?: boolean; level?: string },
): "low" | "medium" | "high" {
  if (modelId.endsWith("-low")) return "low";
  if (modelId.endsWith("-medium")) return "medium";
  if (modelId.endsWith("-high")) return "high";
  if (thinkingOpt?.enabled === false) return "low";
  const level = String(thinkingOpt?.level ?? "high").toLowerCase();
  if (level === "medium") return "medium";
  if (level === "off" || level === "minimal" || level === "low") return "low";
  return "high";
}

function extractBridgeText(content: unknown): string {
  if (typeof content === "string") return content;
  const out: string[] = [];
  for (const part of (Array.isArray(content) ? content : []) as Array<Record<string, unknown>>) {
    if (part.type === "text") out.push(String(part.text ?? ""));
    else if (part.type === "image" || part.type === "image_url") {
      throw new Error("Gemini login bridge does not support image input in text-only CLI mode.");
    }
  }
  return out.join("\n");
}

function toBridgeMessages(transcript: readonly any[], systemPrompt: string) {
  const out: Array<Record<string, unknown>> = systemPrompt
    ? [{ role: "system", content: systemPrompt }]
    : [];
  for (const message of transcript) {
    if (message.role === "system") continue;
    if (message.role === "toolResult") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: extractBridgeText(message.content),
      });
    } else if (message.role === "assistant") {
      const calls = ((message.content ?? []) as any[])
        .filter((p) => p.type === "toolCall")
        .map((p) => ({
          id: p.id,
          type: "function",
          function: { name: p.name, arguments: JSON.stringify(p.arguments ?? {}) },
        }));
      const item: Record<string, unknown> = {
        role: "assistant",
        content: extractBridgeText(message.content),
      };
      if (calls.length > 0) item.tool_calls = calls;
      out.push(item);
    } else if (message.role === "user") {
      out.push({ role: "user", content: extractBridgeText(message.content) });
    } else {
      throw new Error(`Unsupported transcript role: ${String(message.role)}`);
    }
  }
  return out;
}

function toBridgeTools(tools: readonly any[]) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters ?? { type: "object", properties: {} },
    },
  }));
}

function invokeGeminiLoginBridge(
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request aborted"));
      return;
    }
    const script = geminiLoginBridgeScript();
    const proc = spawn("python3", [script], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GEMINI_LOGIN_PARENT_PROCESS_GROUP: "1" },
    });
    let out = "";
    let errOut = "";
    let closed = false;
    let settled = false;
    let cancelReason: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const sendSig = (sig: NodeJS.Signals) => {
      if (!proc.pid) return;
      try {
        if (process.platform === "win32") proc.kill(sig);
        else process.kill(-proc.pid, sig);
      } catch {
        try {
          proc.kill(sig);
        } catch {}
      }
    };

    const timeoutSeconds =
      typeof request.timeout_seconds === "number" ? request.timeout_seconds : 180;
    const hardTimer = setTimeout(
      () => stop("Gemini login bridge timed out"),
      (timeoutSeconds + 15) * 1000,
    );

    const cleanup = () => {
      clearTimeout(hardTimer);
      if (!cancelReason && killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (error?: Error, result?: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    const stop = (reason: string) => {
      if (closed || cancelReason) return;
      cancelReason = reason;
      sendSig("SIGTERM");
      killTimer = setTimeout(() => {
        sendSig("SIGKILL");
        if (closed) return;
        settleTimer = setTimeout(() => {
          proc.stdin.destroy();
          proc.stdout.destroy();
          proc.stderr.destroy();
          proc.unref();
          finish(new Error(cancelReason));
        }, 250);
      }, 5000);
    };

    const onAbort = () => stop("Request aborted");
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (cancelReason) return;
      out += chunk;
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      if (cancelReason || errOut.length > 4096) return;
      errOut += chunk;
    });
    proc.on("error", () => finish(new Error(cancelReason ?? "Cannot start Gemini login bridge.")));
    proc.on("close", (code) => {
      closed = true;
      if (cancelReason || signal?.aborted) {
        finish(new Error(cancelReason ?? "Request aborted"));
        return;
      }
      if (code !== 0) {
        let diag = "";
        try {
          const parsedErr = JSON.parse(errOut);
          diag = parsedErr?.error?.message || "";
        } catch {}
        finish(
          new Error(
            diag ? `Gemini login bridge: ${diag}` : `Gemini login bridge exit ${String(code)}.`,
          ),
        );
        return;
      }
      try {
        const data = JSON.parse(out);
        finish(undefined, data);
      } catch {
        finish(new Error(`Gemini login bridge returned invalid JSON (exit ${String(code)}).`));
      }
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(JSON.stringify(request));
  });
}

function streamViaGeminiLoginBridge(
  model: Model<Api>,
  bridgeModelId: "gemini-4-argon" | "gemini-3.8-flash",
  normalizedContext: TranscriptContext,
  rawContext: TranscriptContext,
  options?: ApiStreamOptions<Api>,
): AssistantMessageEventStream {
  const eventStream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const systemText =
        getCurrentSystemPrompt(normalizedContext.messages) ||
        ((rawContext as { systemPrompt?: string }).systemPrompt ?? "");
      const currentTools = getCurrentTools(normalizedContext.messages);
      const tools =
        currentTools.length > 0
          ? currentTools
          : ((rawContext as { tools?: unknown[] }).tools ?? []);
      const thinkingOpt = (options as any)?.thinking;

      let request: Record<string, unknown> = {
        model: bridgeModelId,
        messages: toBridgeMessages(normalizedContext.messages, systemText),
        tools: toBridgeTools(tools as any[]),
        reasoning_effort: resolveBridgeEffort(model.id, thinkingOpt),
        timeout_seconds: 180,
      };

      const nextBody = await options?.onPayload?.(request, model);
      if (options?.signal?.aborted) throw new Error("Request aborted");
      if (nextBody !== undefined) request = nextBody as Record<string, unknown>;

      const result = await invokeGeminiLoginBridge(request, options?.signal);
      if (options?.signal?.aborted) throw new Error("Request aborted");

      await options?.onResponse?.({ status: 200, headers: {} }, model);
      await options?.onProviderStreamEvent?.(result, model);

      eventStream.push({ type: "start", partial: output });

      if (typeof result.content === "string" && result.content.length > 0) {
        const index = output.content.length;
        const textBlock: TextContent = { type: "text", text: "" };
        output.content.push(textBlock);
        eventStream.push({ type: "text_start", contentIndex: index, partial: output });
        textBlock.text = result.content;
        eventStream.push({
          type: "text_delta",
          contentIndex: index,
          delta: result.content,
          partial: output,
        });
        eventStream.push({
          type: "text_end",
          contentIndex: index,
          content: result.content,
          partial: output,
        });
      }

      for (const call of (result.tool_calls ?? []) as any[]) {
        const index = output.content.length;
        const rawArgs = call?.function?.arguments;
        const parsedArgs =
          typeof rawArgs === "string" ? JSON.parse(rawArgs) : (rawArgs ?? {});
        const toolCall: ToolCall = {
          type: "toolCall",
          id: call.id || `${call?.function?.name || "tool"}_${Date.now()}_${++toolCallCounter}`,
          name: call?.function?.name || "",
          arguments: parsedArgs,
        };
        output.content.push(toolCall);
        eventStream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        eventStream.push({
          type: "toolcall_delta",
          contentIndex: index,
          delta: JSON.stringify(toolCall.arguments),
          partial: output,
        });
        eventStream.push({
          type: "toolcall_end",
          contentIndex: index,
          toolCall,
          partial: output,
        });
      }

      const usage = result.usage ?? {};
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const promptTokens = usage.prompt_tokens ?? 0;
      const completionTokens = usage.completion_tokens ?? 0;
      output.usage = {
        input: Math.max(0, promptTokens - cached),
        output: completionTokens,
        cacheRead: cached,
        cacheWrite: 0,
        totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      calculateCost(model, output.usage);
      output.responseId = result.conversation_id;
      output.stopReason =
        Array.isArray(result.tool_calls) && result.tool_calls.length > 0 ? "toolUse" : "stop";

      eventStream.push({
        type: "done",
        reason: output.stopReason as any,
        message: output,
      });
      eventStream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      eventStream.push({
        type: "error",
        reason: output.stopReason as any,
        error: output,
      });
      eventStream.end();
    }
  })();
  return eventStream;
}

export const stream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: ApiStreamOptions<Api>,
): AssistantMessageEventStream => {
  const normalizedContext = collapseSystemMessages(context);
  const bridgeModelId = resolveBridgeModelId(model.id);
  if (bridgeModelId && hasGeminiLoginBridge() && !(options as { fetch?: typeof fetch })?.fetch) {
    return streamViaGeminiLoginBridge(model, bridgeModelId, normalizedContext, context, options);
  }
  const eventStream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const accessToken =
        options?.apiKey ||
        (options?.headers?.authorization?.replace(/^Bearer\s+/i, "")) ||
        (options?.headers?.Authorization?.replace(/^Bearer\s+/i, ""));

      if (!accessToken) {
        throw new Error(`No access token for provider: ${model.provider}`);
      }

      const contents = convertMessages(model as any, normalizedContext);
      const initialSystemMessage = getInitialSystemMessage(normalizedContext.messages);
      const systemText = initialSystemMessage
        ? getSystemMessageText(initialSystemMessage)
        : ((context as { systemPrompt?: string }).systemPrompt ?? "");

      const generationConfig: Record<string, unknown> = {};
      if (options?.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
      }
      if (options?.maxTokens !== undefined) {
        generationConfig.maxOutputTokens = options.maxTokens;
      }

      const thinkingOpt = (options as any)?.thinking;
      if (thinkingOpt?.enabled && model.reasoning) {
        generationConfig.thinkingConfig = {
          includeThoughts: true,
          ...(thinkingOpt.level
            ? { thinkingLevel: getGoogleThinkingLevel(model.id, String(thinkingOpt.level).toLowerCase()) }
            : { thinkingLevel: getGoogleThinkingLevel(model.id, "high") }),
        };
      } else if (model.reasoning && thinkingOpt && !thinkingOpt.enabled) {
        generationConfig.thinkingConfig = getDisabledThinkingConfig(model.id);
      }

      const requestPayload: Record<string, unknown> = {
        contents,
      };

      if (systemText) {
        requestPayload.systemInstruction = {
          parts: [{ text: sanitizeSurrogates(systemText) }],
        };
      }

      if (Object.keys(generationConfig).length > 0) {
        requestPayload.generationConfig = generationConfig;
      }

      const currentTools = getCurrentTools(normalizedContext.messages);
      const tools = currentTools.length > 0 ? currentTools : ((context as { tools?: unknown[] }).tools ?? []);
      if (tools.length > 0) {
        const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
        requestPayload.tools = convertTools(tools as any, false, supportsStrictMode);
        const toolChoice = (options as any)?.toolChoice;
        if (toolChoice) {
          requestPayload.toolConfig = {
            functionCallingConfig: {
              mode: mapToolChoice(toolChoice),
            },
          };
        }
      }

      const rawProjectId =
        (options as any)?.projectId ||
        options?.headers?.["x-goog-user-project"] ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT_ID ||
        "";
      const projectId = normalizeConsumerProjectId(rawProjectId);

      const requestBody: Record<string, unknown> = {
        project: projectId,
        model: resolveBackendModelId(model.id, thinkingOpt),
        request: requestPayload,
        userAgent: "pi-coding-agent",
        requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      };

      const rawBaseUrl = model.baseUrl?.trim() || DEFAULT_ENDPOINT;
      const baseUrl =
        rawBaseUrl === "https://cloudcode-pa.googleapis.com"
          ? DEFAULT_ENDPOINT
          : rawBaseUrl;
      const endpointUrl = `${baseUrl}/v1internal:streamGenerateContent?alt=sse`;

      const requestHeaders: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": ANTIGRAVITY_USER_AGENT,
        "X-Goog-Api-Client": "gl-node/22.17.0",
        "Client-Metadata": JSON.stringify({
          ideType: "ANTIGRAVITY",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        }),
      };

      const fetchFn = (options as { fetch?: typeof fetch })?.fetch ?? globalThis.fetch;
      const nextBody = await options?.onPayload?.(requestBody, model);
      const finalBody = nextBody !== undefined ? nextBody : requestBody;

      const response = await retryGoogleRequest(async () => {
        const res = await fetchFn(endpointUrl, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(finalBody),
          signal: options?.signal,
        });
        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          const error: any = new Error(
            `Cloud Code Assist API error (${res.status}): ${errorText || res.statusText}`,
          );
          error.status = res.status;
          error.headers = headersToRecord(res.headers);
          throw error;
        }
        return res;
      }, options);

      await options?.onResponse?.(
        {
          status: response.status,
          headers: headersToRecord(response.headers),
        },
        model,
      );

      if (!response.body) {
        throw new Error("No response body received from Cloud Code Assist");
      }

      let started = false;
      const ensureStarted = () => {
        if (!started) {
          eventStream.push({ type: "start", partial: output });
          started = true;
        }
      };

      let currentBlock: TextContent | ThinkingContent | null = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          if (options?.signal?.aborted) {
            throw new Error("Request aborted");
          }
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            let chunk: any;
            try {
              chunk = JSON.parse(jsonStr);
            } catch {
              continue;
            }

            await options?.onProviderStreamEvent?.(chunk, model);

            const responseData = chunk.response ?? chunk;
            output.responseId ||= responseData.responseId;

            const candidate = responseData.candidates?.[0];
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text !== undefined) {
                  const isThinking = isThinkingPart(part) || part.thought === true;
                  if (
                    !currentBlock ||
                    (isThinking && currentBlock.type !== "thinking") ||
                    (!isThinking && currentBlock.type !== "text")
                  ) {
                    if (currentBlock) {
                      if (currentBlock.type === "text") {
                        eventStream.push({
                          type: "text_end",
                          contentIndex: blockIndex(),
                          content: currentBlock.text,
                          partial: output,
                        });
                      } else {
                        eventStream.push({
                          type: "thinking_end",
                          contentIndex: blockIndex(),
                          content: currentBlock.thinking,
                          partial: output,
                        });
                      }
                    }
                    if (isThinking) {
                      currentBlock = {
                        type: "thinking",
                        thinking: "",
                        thinkingSignature: undefined,
                      };
                      output.content.push(currentBlock);
                      ensureStarted();
                      eventStream.push({
                        type: "thinking_start",
                        contentIndex: blockIndex(),
                        partial: output,
                      });
                    } else {
                      currentBlock = {
                        type: "text",
                        text: "",
                      };
                      output.content.push(currentBlock);
                      ensureStarted();
                      eventStream.push({
                        type: "text_start",
                        contentIndex: blockIndex(),
                        partial: output,
                      });
                    }
                  }

                  if (currentBlock.type === "thinking") {
                    currentBlock.thinking += part.text;
                    currentBlock.thinkingSignature = retainThoughtSignature(
                      currentBlock.thinkingSignature,
                      part.thoughtSignature,
                    );
                    eventStream.push({
                      type: "thinking_delta",
                      contentIndex: blockIndex(),
                      delta: part.text,
                      partial: output,
                    });
                  } else {
                    currentBlock.text += part.text;
                    currentBlock.textSignature = retainThoughtSignature(
                      currentBlock.textSignature,
                      part.thoughtSignature,
                    );
                    eventStream.push({
                      type: "text_delta",
                      contentIndex: blockIndex(),
                      delta: part.text,
                      partial: output,
                    });
                  }
                }

                if (part.functionCall) {
                  if (currentBlock) {
                    if (currentBlock.type === "text") {
                      eventStream.push({
                        type: "text_end",
                        contentIndex: blockIndex(),
                        content: currentBlock.text,
                        partial: output,
                      });
                    } else {
                      eventStream.push({
                        type: "thinking_end",
                        contentIndex: blockIndex(),
                        content: currentBlock.thinking,
                        partial: output,
                      });
                    }
                    currentBlock = null;
                  }

                  const providedId = part.functionCall.id;
                  const toolCallId =
                    providedId || `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`;

                  const toolCall: ToolCall = {
                    type: "toolCall",
                    id: toolCallId,
                    name: part.functionCall.name || "",
                    arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
                    ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
                  };

                  output.content.push(toolCall);
                  ensureStarted();
                  eventStream.push({
                    type: "toolcall_start",
                    contentIndex: blockIndex(),
                    partial: output,
                  });
                  eventStream.push({
                    type: "toolcall_delta",
                    contentIndex: blockIndex(),
                    delta: JSON.stringify(toolCall.arguments),
                    partial: output,
                  });
                  eventStream.push({
                    type: "toolcall_end",
                    contentIndex: blockIndex(),
                    toolCall,
                    partial: output,
                  });
                }
              }
            }

            if (candidate?.finishReason) {
              output.stopReason = mapStopReasonString(candidate.finishReason);
              if (output.content.some((b) => b.type === "toolCall")) {
                output.stopReason = "toolUse";
              }
            }

            if (responseData.usageMetadata) {
              const promptTokens = responseData.usageMetadata.promptTokenCount || 0;
              const cacheReadTokens = responseData.usageMetadata.cachedContentTokenCount || 0;
              const candidatesTokens = responseData.usageMetadata.candidatesTokenCount || 0;
              const thoughtsTokens = responseData.usageMetadata.thoughtsTokenCount || 0;
              const totalTokens = responseData.usageMetadata.totalTokenCount || 0;

              output.usage = {
                input: Math.max(0, promptTokens - cacheReadTokens),
                output: candidatesTokens + thoughtsTokens,
                cacheRead: cacheReadTokens,
                cacheWrite: 0,
                totalTokens: totalTokens || (promptTokens + candidatesTokens + thoughtsTokens),
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              };
              calculateCost(model, output.usage);
            }
          }
        }
      } finally {
        reader.releaseLock?.();
      }

      if (currentBlock) {
        if (currentBlock.type === "text") {
          eventStream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: currentBlock.text,
            partial: output,
          });
        } else {
          eventStream.push({
            type: "thinking_end",
            contentIndex: blockIndex(),
            content: currentBlock.thinking,
            partial: output,
          });
        }
      }

      ensureStarted();
      eventStream.push({
        type: "done",
        reason: output.stopReason as any,
        message: output,
      });
      eventStream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      eventStream.push({
        type: "error",
        reason: output.stopReason as any,
        error: output,
      });
      eventStream.end();
    }
  })();

  return eventStream;
};

export const streamSimple = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const accessToken = options?.apiKey;
  if (!accessToken) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = {
    ...buildBaseOptions(model, context, options, accessToken),
    toolChoice: options?.toolChoice,
  };

  if (!options?.reasoning) {
    return stream(model, context, { ...base, thinking: { enabled: false } } as any);
  }

  const clampedReasoning = clampThinkingLevel(model, options.reasoning);
  if (clampedReasoning === "off") {
    return stream(model, context, { ...base, thinking: { enabled: false } } as any);
  }

  return stream(model, context, {
    ...base,
    thinking: {
      enabled: true,
      level: getGoogleThinkingLevel(model.id, clampedReasoning),
    },
  } as any);
};

export function googleGeminiCliProvider(): Provider {
  return createProvider({
    id: GEMINI_CLI_PROVIDER_ID,
    name: GEMINI_CLI_PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    auth: {
      oauth: {
        name: GEMINI_CLI_PROVIDER_NAME,
        login: async () => {
          throw new Error("Interactive login is managed via pi auth.json");
        },
        refresh: async (credential: OAuthCredential, signal: AbortSignal) => {
          return refreshGoogleCloudToken(credential, signal);
        },
        toAuth: async (credential: OAuthCredential): Promise<ModelAuth> => {
          const rawProjectId = (credential as Record<string, unknown>).projectId as string | undefined;
          const projectId = normalizeConsumerProjectId(rawProjectId);
          return {
            apiKey: credential.access,
            headers: {
              Authorization: `Bearer ${credential.access}`,
              ...(projectId ? { "x-goog-user-project": projectId } : {}),
            },
          };
        },
      },
      apiKey: {
        name: GEMINI_CLI_PROVIDER_NAME,
        resolve: async () => {
          if (hasGeminiLoginBridge()) {
            return {
              auth: { apiKey: BRIDGE_MANAGED_TOKEN },
              source: "Gemini Login Bridge",
            };
          }
          return undefined;
        },
      },
    },
    models: [
      {
        id: "gemini-4-argon",
        name: "Gemini 4 Argon",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65536,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
        type: "chat",
        thinkingLevelMap: {
          off: "low",
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "high",
          max: "high",
        },
      },
      {
        id: "gemini-4-argon-high",
        name: "Gemini 4 Argon (High)",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65536,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
        type: "chat",
        thinkingLevelMap: {
          off: "high",
          minimal: "high",
          low: "high",
          medium: "high",
          high: "high",
          xhigh: "high",
          max: "high",
        },
      },
      {
        id: "gemini-4-argon-medium",
        name: "Gemini 4 Argon (Medium)",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65536,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
        type: "chat",
        thinkingLevelMap: {
          off: "medium",
          minimal: "medium",
          low: "medium",
          medium: "medium",
          high: "medium",
          xhigh: "medium",
          max: "medium",
        },
      },
      {
        id: "gemini-4-argon-low",
        name: "Gemini 4 Argon (Low)",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65536,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
        type: "chat",
        thinkingLevelMap: {
          off: "low",
          minimal: "low",
          low: "low",
          medium: "low",
          high: "low",
          xhigh: "low",
          max: "low",
        },
      },
      {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65536,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
        type: "chat",
        thinkingLevelMap: {
          off: "low",
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "high",
          max: "high",
        },
      },
      {
        id: "gemini-3.8-flash-high",
        name: "Gemini 3.8 Flash (High)",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65536,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
        type: "chat",
        thinkingLevelMap: {
          off: "high",
          minimal: "high",
          low: "high",
          medium: "high",
          high: "high",
          xhigh: "high",
          max: "high",
        },
      },
      {
        id: "gemini-3.8-flash-medium",
        name: "Gemini 3.8 Flash (Medium)",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65536,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
        type: "chat",
        thinkingLevelMap: {
          off: "medium",
          minimal: "medium",
          low: "medium",
          medium: "medium",
          high: "medium",
          xhigh: "medium",
          max: "medium",
        },
      },
      {
        id: "gemini-3.8-flash-low",
        name: "Gemini 3.8 Flash (Low)",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65536,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
        type: "chat",
        thinkingLevelMap: {
          off: "low",
          minimal: "low",
          low: "low",
          medium: "low",
          high: "low",
          xhigh: "low",
          max: "low",
        },
      },
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65535,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        type: "chat",
      },
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        api: GEMINI_CLI_PROVIDER_ID as Api,
        provider: GEMINI_CLI_PROVIDER_ID,
        baseUrl: DEFAULT_ENDPOINT,
        contextWindow: 1048576,
        maxTokens: 65535,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        type: "chat",
      },
    ],
    api: {
      stream,
      streamSimple,
    },
  });
}
