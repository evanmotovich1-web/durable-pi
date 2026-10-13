// Claude Code as its own CLI route, not a model credential. `claude -p` uses the
// machine's signed-in Claude Code login. This file never reads or passes an Anthropic token.
import { Type } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { HarnessExtensionInfo } from "../../dpi-sdk/src/api.js";

export const CLAUDE_CODE_NAME = "claude-code";
export const CLAUDE_CODE_TIMEOUT_MAX_SEC = 600;
export const SMART_ASS_OPUS_PROMPT = readFileSync(
  join(import.meta.dirname, "../prompts/smart_ass_opus_fix.md"),
  "utf8",
).trim();

// Vendored from dpi-network/router/effort-map.json so remote backends do not need that checkout.
type EffortWord = "off" | "low" | "medium" | "high" | "max";
const EFFORT_WORDS = ["off", "low", "medium", "high", "max"] as const;
const effortMap = JSON.parse(readFileSync(join(import.meta.dirname, "effort-map.json"), "utf8")) as {
  map: Record<EffortWord, { claude_effort: string | null; claude_omit_flag: boolean }>;
};

export function claudeEffort(value: EffortWord | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!EFFORT_WORDS.includes(value)) throw Error(`effort must be ${EFFORT_WORDS.join(", ")}`);
  const mapped = effortMap.map[value];
  if (mapped?.claude_omit_flag) return undefined;
  if (!mapped?.claude_effort) throw Error(`No Claude Code effort mapping for ${value}`);
  return mapped.claude_effort;
}

/** Paths the CLI needs to find `claude` and its on-disk login. Tokens are not in this list. */
const LOGIN_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;

const BLOCKED_ENV = /TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL|^ANTHROPIC_/i;

/** Env for the `claude` process. An allowlist, then a token-name reject. Never copies an Anthropic token. */
export function claudeLoginEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of LOGIN_ENV_KEYS) {
    if (BLOCKED_ENV.test(key)) continue;
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

export function claudeTimeoutSec(value: number | undefined): number {
  const timeoutSec = value ?? CLAUDE_CODE_TIMEOUT_MAX_SEC;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > CLAUDE_CODE_TIMEOUT_MAX_SEC) {
    throw Error(`timeoutSec must be an integer from 1 to ${CLAUDE_CODE_TIMEOUT_MAX_SEC}`);
  }
  return timeoutSec;
}

export const claudeCodeInfo: Omit<HarnessExtensionInfo, "enabled" | "prompts"> = {
  name: CLAUDE_CODE_NAME,
  title: "Claude Code",
  description:
    "Runs a prompt through the Claude Code CLI on this machine's signed-in login. No API token is passed. Off until this agent turns it on.",
};

export const claudeCodeTool = defineTool({
  name: "claude_code",
  description:
    "Run a prompt with the Claude Code CLI (`claude -p`) on this machine's signed-in login. Optional model, effort, and appended system prompt are passed as CLI flags; the smart-ass Opus prompt is appended by default. Effort off omits the flag. Returns final text. There is no API-key argument. timeoutSec is at most 600 seconds. An interrupted run is not started again.",
  parameters: Type.Object({
    prompt: Type.String({ description: "Prompt for Claude Code. Passed as an argument, not through a shell." }),
    model: Type.Optional(Type.String({ minLength: 1, description: "Claude Code model alias or full model ID, passed through --model." })),
    effort: Type.Optional(Type.Union([
      Type.Literal("off"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("max"),
    ], { description: "Shared effort word. Off omits --effort; it does not disable Claude's default reasoning." })),
    appendSystemPrompt: Type.Optional(Type.String({ description: "Text passed through --append-system-prompt. An empty string omits it. Defaults to smart_ass_opus_fix.md." })),
    timeoutSec: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: CLAUDE_CODE_TIMEOUT_MAX_SEC,
        description: "Hard timeout in seconds. Default 600. Maximum 600.",
      }),
    ),
  }),
  // Default would also be unsafe. Set it so a crash mid-run reports interrupted and does not start `claude` again.
  replay: "unsafe",
  execute: (args, api, ctx) => runClaudeCode(args, api, ctx),
});

export const claudeCodeExtension = defineExtension({
  name: CLAUDE_CODE_NAME,
  tools: [claudeCodeTool],
});

export async function runClaudeCode(
  args: { prompt: string; model?: string; effort?: EffortWord; appendSystemPrompt?: string; timeoutSec?: number },
  api: Pick<ToolExecutionApi, "env" | "agent" | "output">,
  ctx: Context,
) {
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw Error("prompt is required");
  if (args.model !== undefined && (typeof args.model !== "string" || !args.model.trim() || args.model.startsWith("-")))
    throw Error("model must be a nonempty Claude model alias or ID");
  if (args.appendSystemPrompt !== undefined && typeof args.appendSystemPrompt !== "string")
    throw Error("appendSystemPrompt must be a string");
  const effort = claudeEffort(args.effort);
  const appendedPrompt = args.appendSystemPrompt ?? SMART_ASS_OPUS_PROMPT;
  const timeoutSec = claudeTimeoutSec(args.timeoutSec);
  const env = api.env;
  if (!env) throw Error("claude_code needs the session environment");
  const cwd = (await api.agent(ctx)).cwd ?? env.cwd;
  const argv = ["claude", "-p", args.prompt];
  if (args.model) argv.push("--model", args.model);
  if (effort) argv.push("--effort", effort);
  if (appendedPrompt) argv.push("--append-system-prompt", appendedPrompt);
  let stdout = "";
  let stderr = "";
  // Array argv: no shell, so the prompt is not parsed and no token can be interpolated into a command string.
  const result = await env.exec(
    argv,
    {
      cwd,
      env: claudeLoginEnv(),
      inheritEnv: false,
      timeout: timeoutSec,
      onOutput: (text, _context, info) => {
        if (info.stream === "stdout") {
          stdout += text;
          api.output(text);
        } else {
          stderr += text;
        }
      },
    },
    ctx,
  );
  if (!result.ok) {
    if (result.error.code === "timeout") throw Error(`claude -p timed out after ${timeoutSec} seconds`);
    if (result.error.code === "aborted") throw Error("claude -p was aborted");
    if (result.error.code === "spawn_error" && /ENOENT|not found/i.test(result.error.message)) {
      throw Error("claude is not on PATH. This tool uses the machine's signed-in Claude Code login and does not take a token.");
    }
    throw Error(`claude -p failed: ${result.error.message}`);
  }
  if (result.value.exitCode !== 0) {
    const detail = (stderr.trim() || stdout.trim()).slice(0, 2000);
    throw Error(`claude -p exited ${result.value.exitCode}${detail ? `: ${detail}` : ""}`);
  }
  return { content: [{ type: "text" as const, text: stdout.trimEnd() }] };
}
