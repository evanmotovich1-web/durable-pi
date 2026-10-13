import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ADDON_INFO, createAddons, PROMPTS } from "../src/addons.js";
import {
  CLAUDE_CODE_NAME,
  CLAUDE_CODE_TIMEOUT_MAX_SEC,
  SMART_ASS_OPUS_PROMPT,
  claudeCodeTool,
  claudeEffort,
  claudeLoginEnv,
  claudeTimeoutSec,
} from "../src/claude-code.js";
import { WRITE_TOOLS } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

const TOKEN = "dpi-test-anthropic-token-do-not-pass";
const TOKEN_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

test("login env copies PATH and HOME and never an Anthropic token", () => {
  const env = claudeLoginEnv({
    PATH: "/usr/bin",
    HOME: "/Users/example",
    ANTHROPIC_API_KEY: TOKEN,
    ANTHROPIC_AUTH_TOKEN: TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/Users/example");
  assert.equal(JSON.stringify(env).includes(TOKEN), false);
  for (const key of TOKEN_KEYS) assert.equal(key in env, false);
  assert.equal(claudeCodeTool.replay, "unsafe");
  assert.equal(claudeTimeoutSec(undefined), CLAUDE_CODE_TIMEOUT_MAX_SEC);
  assert.throws(() => claudeTimeoutSec(601), /1 to 600/);
  const schema = claudeCodeTool.parameters as unknown as { properties: { timeoutSec: { maximum: number } } };
  assert.equal(schema.properties.timeoutSec.maximum, 600);
  assert.equal(SMART_ASS_OPUS_PROMPT, PROMPTS[0].text);
  assert.deepEqual(["off", "low", "medium", "high", "max"].map((x) => claudeEffort(x as "off" | "low" | "medium" | "high" | "max")),
    [undefined, "low", "medium", "high", "max"]);
  assert.throws(() => claudeEffort("xhigh" as "high"), /effort must be/);
});

test("claude_code runs the stub `claude -p` in the session cwd and returns its text", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-claude-")));
  const bin = join(root, "bin");
  const session = join(root, "session");
  const record = join(root, "record.txt");
  const argsRecord = join(root, "args.bin");
  const saved: Record<string, string | undefined> = { PATH: process.env.PATH };
  for (const key of TOKEN_KEYS) saved[key] = process.env[key];
  try {
    await mkdir(bin);
    await mkdir(session);
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh
rec='${record}'
printf '%s\\0' "$@" > '${argsRecord}'
{
  printf 'cwd=%s\\n' "$(pwd)"
  for arg in "$@"; do
    printf 'arg=%s\\n' "$arg"
  done
  printf '---env---\\n'
  env
} > "$rec"
for arg in "$@"; do
  if [ "$arg" = "__sleep__" ]; then
    sleep 5
    exit 0
  fi
done
printf 'stub final text\\n'
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
    for (const key of TOKEN_KEYS) process.env[key] = TOKEN;

    const prompt = "hello $(whoami) `pwd` && echo pwned";
    const ran = await claudeCodeTool.execute(
      { prompt, timeoutSec: 30 },
      api(session),
      BACKGROUND_CONTEXT,
    );
    assert.equal(textOf(ran), "stub final text");
    const recorded = await readFile(record, "utf8");
    const args = () => readFile(argsRecord).then((data) => data.toString("utf8").split("\0").slice(0, -1));
    assert.deepEqual(await args(), ["-p", prompt, "--append-system-prompt", SMART_ASS_OPUS_PROMPT]);
    const cwdLine = recorded.split("\n").find((line) => line.startsWith("cwd=")) ?? "";
    assert.equal(await realpath(cwdLine.slice(4)), await realpath(session));
    assert.equal(recorded.includes(TOKEN), false);
    for (const key of TOKEN_KEYS) assert.equal(recorded.includes(`${key}=`), false);

    const routed = await claudeCodeTool.execute(
      { prompt: "review this", model: "opus", effort: "high", appendSystemPrompt: "Custom\nInstructions" },
      api(session),
      BACKGROUND_CONTEXT,
    );
    assert.equal(textOf(routed), "stub final text");
    assert.deepEqual(await args(), ["-p", "review this", "--model", "opus", "--effort", "high", "--append-system-prompt", "Custom\nInstructions"]);

    await claudeCodeTool.execute(
      { prompt: "no explicit effort or appended prompt", effort: "off", appendSystemPrompt: "" },
      api(session),
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(await args(), ["-p", "no explicit effort or appended prompt"]);

    await assert.rejects(
      () => claudeCodeTool.execute({ prompt: "__sleep__", timeoutSec: 1 }, api(session), BACKGROUND_CONTEXT),
      /timed out after 1 seconds/,
    );
    await assert.rejects(
      () => claudeCodeTool.execute({ prompt: "x", timeoutSec: 601 }, api(session), BACKGROUND_CONTEXT),
      /1 to 600/,
    );
    await assert.rejects(
      () => claudeCodeTool.execute({ prompt: "x", model: "--danger" }, api(session), BACKGROUND_CONTEXT),
      /model must be/,
    );
    const afterReject = await readFile(record, "utf8");
    assert.match(afterReject, /arg=__sleep__/);
    assert.equal(afterReject.includes(TOKEN), false);
  } finally {
    process.env.PATH = saved.PATH;
    for (const key of TOKEN_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("missing claude is an error and does not invent a token route", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-claude-missing-")));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = root;
    await assert.rejects(
      () => claudeCodeTool.execute({ prompt: "hi", timeoutSec: 5 }, api(root), BACKGROUND_CONTEXT),
      /claude is not on PATH/,
    );
  } finally {
    process.env.PATH = savedPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("claude-code is installed, off until the agent turns it on, and marked as a write", async () => {
  assert.equal(ADDON_INFO.some((info) => info.name === CLAUDE_CODE_NAME), true);
  const addons = createAddons({ offline: true });
  assert.equal(addons.all[CLAUDE_CODE_NAME]?.name, CLAUDE_CODE_NAME);
  assert.equal(WRITE_TOOLS.has("claude_code"), true);
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Claude", cwd: t.work, model: faux });
    const { row, c } = await store.resolveAgent(session.id, "main");
    const off = await store.extensionsOf(row, c);
    assert.equal(off.extensions.find((ext) => ext.name === CLAUDE_CODE_NAME)?.enabled, false);
    const on = await store.setExtension(row, c, { name: CLAUDE_CODE_NAME, enabled: true });
    assert.equal(on.extensions.find((ext) => ext.name === CLAUDE_CODE_NAME)?.enabled, true);
    const detail = await store.agentDetail(row, c);
    const tool = detail.tools.find((item) => item.name === "claude_code");
    assert.equal(tool?.replay, "unsafe");
    assert.equal(tool?.writes, true);
    assert.equal(tool?.offered, true);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

function api(cwd: string): ToolExecutionApi {
  return {
    env: new NodeExecutionEnv({ cwd }),
    output() {},
    agent: async () => ({ cwd }),
  } as unknown as ToolExecutionApi;
}

function textOf(result: { content?: readonly { type: string; text?: string }[] }) {
  const block = result.content?.[0];
  return block && "text" in block ? block.text : "";
}
