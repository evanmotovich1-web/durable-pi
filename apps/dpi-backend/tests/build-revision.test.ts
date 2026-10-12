import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readBuildRevision } from "../src/build-revision.js";
import { bootServer, newToken, tempStore } from "./helpers.js";

test("build revision uses checkout SHA and copied-install VERSION", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const expected = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(readBuildRevision(root), expected);

  const copy = mkdtempSync(join(tmpdir(), "dpi-version-"));
  try {
    writeFileSync(join(copy, "VERSION"), `${expected}\n`);
    assert.equal(readBuildRevision(copy), expected);
    writeFileSync(join(copy, "VERSION"), "untrusted text\n");
    assert.equal(readBuildRevision(copy), "unknown");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("GET /v1/device reports the backend build revision", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const response = await fetch(`${server.base}/v1/device`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const info = (await response.json()) as { buildRevision: string };
    assert.equal(info.buildRevision, readBuildRevision(resolve(import.meta.dirname, "../../..")));
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
