import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Store } from "../src/store.js";
import { PiAuthStore } from "../src/pi-auth-store.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

const oauth = () => ({ type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3600_000 });
const key = () => ({ type: "api_key", key: "fake-key" });

test("native device lists only credentialed, live-probed model lanes", async () => {
  const t = await tempStore();
  const authPath = join(t.root, "auth.json");
  await writeFile(authPath, JSON.stringify({
    "openai-codex": oauth(), xai: oauth(), "zai-coding-cn": key(), deepseek: key(), openrouter: key(),
  }), { mode: 0o600 });
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "server"), startDirs: t.work, token, provider: "native", authPath });
  try {
    const res = await fetch(`${server.base}/v1/device`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const device = await res.json();
    assert.deepEqual(device.models.map((m: { provider: string; id: string }) => [m.provider, m.id]), [
      ["openai-codex", "gpt-6-sol"], ["xai", "grok-4.7"], ["zai-coding-cn", "glm-5.3"], ["deepseek", "deepseek-v4-pro"],
    ]);
    assert.equal(device.defaultModel, "gpt-6-sol");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("native validation requires a credentialed provider and chooses first available fallback", async () => {
  const t = await tempStore();
  const authPath = join(t.root, "auth.json");
  await writeFile(authPath, JSON.stringify({ xai: oauth(), "openai-codex": key() }), { mode: 0o600 });
  const store = await Store.open({ ...t.options, provider: "native", credentials: new PiAuthStore(authPath) });
  try {
    assert.deepEqual(store.deviceInfo().models.map((m) => m.provider), ["xai"]);
    assert.equal(store.deviceInfo().defaultModel, "grok-4.7");
    assert.deepEqual(store.validateModel({ provider: "xai", modelId: "grok-4.7" }), { provider: "xai", modelId: "grok-4.7" });
    assert.throws(() => store.validateModel({ provider: "openai-codex", modelId: "gpt-6-sol" }), /Unknown model/);
    assert.throws(() => store.validateModel({ provider: "openrouter", modelId: "x-ai\/grok-4.7" }), /Unknown model/);
    assert.throws(() => store.validateModel(faux), /Unknown model/);
    assert.deepEqual(store.routedModel({ provider: "openrouter", modelId: "x-ai/grok-4.7" }),
      { provider: "xai", modelId: "grok-4.7" });
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("an existing faux session opens after the backend switches to native providers", async () => {
  const t = await tempStore();
  const authPath = join(t.root, "auth.json");
  await writeFile(authPath, JSON.stringify({ "openai-codex": oauth() }), { mode: 0o600 });
  const original = await t.open();
  const session = await original.create({ name: "legacy faux", cwd: t.work, model: faux });
  await original.close();
  const native = await Store.open({ ...t.options, provider: "native", credentials: new PiAuthStore(authPath) });
  try {
    assert.equal(native.list()[0].id, session.id);
    assert.equal(native.list()[0].provider, "faux");
    assert.deepEqual((await native.resolveAgent(session.id, "main")).c.id, 1);
    assert.deepEqual(native.routedModel(faux), faux);
    assert.deepEqual(native.deviceInfo().models.map((m) => m.provider), ["openai-codex"]);
  } finally {
    await native.close();
    await t.cleanup();
  }
});
