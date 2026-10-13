import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeAvailable } from "../src/device-capabilities.js";
import { tempStore } from "./helpers.js";

test("Claude Code is advertised only when the CLI reports a signed-in login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-claude-probe-"));
  const script = join(dir, "claude");
  try {
    const status = async (body: string) => {
      await writeFile(script, `#!/bin/sh\n[ "$1" = auth ] && [ "$2" = status ] || exit 2\n${body}\n`);
      await chmod(script, 0o700);
      return claudeCodeAvailable({ PATH: dir, HOME: dir });
    };
    assert.equal(await status('printf \'{"loggedIn":true}\''), true);
    assert.equal(await status('printf \'{"loggedIn":false}\''), false);
    assert.equal(await status("printf invalid"), false);
    assert.equal(await claudeCodeAvailable({ PATH: join(dir, "missing"), HOME: dir }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("device capability snapshot uses one startup probe", async () => {
  const t = await tempStore();
  let probes = 0;
  const store = await (await import("../src/store.js")).Store.open({
    ...t.options,
    claudeCodeProbe: async () => { probes++; return true; },
  });
  try {
    assert.deepEqual(store.deviceInfo().capabilities.harnesses, ["pi", "claude-code"]);
    assert.deepEqual(store.deviceInfo().capabilities.harnesses, ["pi", "claude-code"]);
    assert.equal(probes, 1);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
