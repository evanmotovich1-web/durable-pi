import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { PiAuthStore } from "../src/pi-auth-store.js";
import { tempStore } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function concurrentRefresh(other: "pi" | "dpi") {
  const t = await tempStore();
  const authPath = join(t.root, "auth.json");
  const countPath = join(t.root, "refresh-count");
  await writeFile(authPath, JSON.stringify({
    "openai-codex": { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() + 60_000 },
  }), { mode: 0o600 });
  await writeFile(countPath, "0");
  try {
    const child = resolve(import.meta.dirname, "auth-refresh-child.ts");
    const results = await Promise.all(["dpi", other].map((kind) =>
      execFileAsync(process.execPath, ["--import", "tsx", child, kind, authPath, countPath],
        { cwd: resolve(import.meta.dirname, ".."), timeout: 10_000 })));
    assert.deepEqual(results.map((r) => r.stdout.trim()), ["done", "done"]);
    assert.equal(await readFile(countPath, "utf8"), "1", "the shared lock permits exactly one renewal");
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(auth["openai-codex"].access, "old-access-renewed");
    assert.equal(auth["openai-codex"].refresh, "new-refresh");
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  } finally {
    await t.cleanup();
  }
}

test("PiAuthStore and pi's real AuthStorage coordinate one OAuth renewal", async () => {
  await concurrentRefresh("pi");
});

test("two Durable Pi processes coordinate one OAuth renewal", async () => {
  await concurrentRefresh("dpi");
});

test("credential metadata omits secrets and Durable Pi cannot log out or write API keys", async () => {
  const t = await tempStore();
  const authPath = join(t.root, "auth.json");
  await writeFile(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "fake-secret" } }), { mode: 0o600 });
  const store = new PiAuthStore(authPath);
  try {
    assert.deepEqual(await store.list(), [{ providerId: "deepseek", type: "api_key" }]);
    assert.doesNotMatch(JSON.stringify(await store.list()), /fake-secret/);
    await assert.rejects(() => store.delete("deepseek"), /cannot log out/);
    await assert.rejects(() => store.modify("deepseek", async () => ({ type: "api_key", key: "different" })),
      /only refresh an existing OAuth/);
    assert.equal((await store.read("deepseek"))?.type, "api_key");
  } finally {
    await t.cleanup();
  }
});

test("stored API-key references resolve like pi without changing auth.json", async () => {
  const t = await tempStore();
  const authPath = join(t.root, "auth.json");
  const original = JSON.stringify({
    deepseek: { type: "api_key", key: "prefix-${DPI_TEST_KEY}$$$!", env: { DPI_TEST_KEY: "test-value" } },
    "zai-coding-cn": { type: "api_key", key: "!printf command-value" },
  });
  await writeFile(authPath, original, { mode: 0o600 });
  const store = new PiAuthStore(authPath);
  try {
    assert.deepEqual(await store.read("deepseek"), {
      type: "api_key", key: "prefix-test-value$!", env: { DPI_TEST_KEY: "test-value" },
    });
    assert.deepEqual(await store.read("zai-coding-cn"), { type: "api_key", key: "command-value" });
    assert.equal(await readFile(authPath, "utf8"), original);
  } finally {
    await t.cleanup();
  }
});
