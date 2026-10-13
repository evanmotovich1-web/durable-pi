import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { AgentExecutionEnv, agentShellEnv } from "../src/exec-env.js";

const PLANTED = { DPI_TOKEN: "dpi_planted_token_for_test_only_0000000000", TYPESAFE_API_KEY: "planted-typesafe-test-key" };

async function envOf(env: NodeExecutionEnv, options?: { env?: Record<string, string>; inheritEnv?: boolean }) {
  let out = "";
  const result = await env.exec(["/usr/bin/env"], { ...options, onOutput: (text) => (out += text) }, BACKGROUND_CONTEXT);
  assert.ok(result.ok, `exec failed: ${JSON.stringify(result)}`);
  return out;
}

test("agent commands never inherit the backend's secrets", async () => {
  Object.assign(process.env, PLANTED);
  try {
    // The stock env leaks them: this is the behavior AgentExecutionEnv exists to stop.
    const stock = await envOf(new NodeExecutionEnv({ cwd: process.cwd(), shellEnv: agentShellEnv() }));
    assert.match(stock, /^DPI_TOKEN=/m);

    const out = await envOf(new AgentExecutionEnv({ cwd: process.cwd() }));
    assert.doesNotMatch(out, /DPI_TOKEN|TYPESAFE_API_KEY|planted/);
    assert.match(out, /^PATH=/m);
    assert.match(out, /^HOME=/m);
  } finally {
    for (const k of Object.keys(PLANTED)) delete process.env[k];
  }
});

test("per-call env still applies, and an explicit inheritEnv:false caller is untouched", async () => {
  Object.assign(process.env, PLANTED);
  try {
    const env = new AgentExecutionEnv({ cwd: process.cwd() });
    assert.match(await envOf(env, { env: { EXTRA_FLAG: "1" } }), /^EXTRA_FLAG=1$/m);
    const own = await envOf(env, { env: { ONLY: "x" }, inheritEnv: false });
    assert.match(own, /^ONLY=x$/m);
    assert.doesNotMatch(own, /^PATH=|DPI_TOKEN/m);
  } finally {
    for (const k of Object.keys(PLANTED)) delete process.env[k];
  }
});

test("Windows agent shell keeps required OS variables without backend secrets", () => {
  const source = {
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    USERPROFILE: "C:\\Users\\evan",
    APPDATA: "C:\\Users\\evan\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\evan\\AppData\\Local",
    TEMP: "C:\\Users\\evan\\AppData\\Local\\Temp",
    TMP: "C:\\Users\\evan\\AppData\\Local\\Temp",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\evan",
    DPI_TOKEN: "planted-device-token",
    TYPESAFE_API_KEY: "planted-api-key",
    EXAMPLE_API_KEY: "another-planted-api-key",
  };
  const allowed = agentShellEnv(source, "win32");
  for (const key of ["PATH", "SystemRoot", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH"]) {
    assert.equal(allowed[key], source[key as keyof typeof source]);
  }
  assert.ok(!("DPI_TOKEN" in allowed));
  assert.ok(Object.keys(allowed).every((key) => !key.endsWith("_API_KEY")));
});
