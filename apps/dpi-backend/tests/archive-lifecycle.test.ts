import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("sweeper keeps live, pinned, factory-referenced and new sessions; archives idle work and restores history", async () => {
  const t = await tempStore();
  const mapPath = join(t.root, "map.sqlite");
  const map = new DatabaseSync(mapPath);
  map.exec("CREATE TABLE handoffs(session_id TEXT,session_name TEXT)");
  let now = Date.now();
  const store = await Store.open({ ...t.options, now: () => now, keepListFile: mapPath });
  try {
    const idle = await store.create({ name: "Idle", cwd: t.work, model: faux });
    const idleAgent = await store.resolveAgent(idle.id, "main");
    const done = await store.send(idleAgent.c, { content: "remember this", requestId: "archive-history" });
    assert.equal((await store.settled(idleAgent.h, done.id as number, 10000)).status, "done");
    const pinned = await store.create({ name: "Pinned", cwd: t.work, model: faux });
    assert.equal((await store.pin(store.row(pinned.id), true)).pinned, true);
    const kept = await store.create({ name: "Factory", cwd: t.work, model: faux });
    map.prepare("INSERT INTO handoffs VALUES(?,?)").run(kept.id, kept.name);
    const live = await store.create({ name: "Live", cwd: t.work, model: faux });
    const running = await store.resolveAgent(live.id, "main");
    const slow = await store.send(running.c, { content: "!sleep 3; echo ready", requestId: "live-sweep" });
    await until(async () => (await store.sessionSummary(store.row(live.id))).live, 2000, "live agent");
    now += 13 * 3_600_000;
    store.catalog.prepare("UPDATE sessions SET lastActivityAt=? WHERE id=?").run(now - 13 * 3_600_000, live.id);
    assert.equal((await store.sessionSummary(store.row(live.id))).live, true);
    const archived = await store.sweepArchives();
    assert.deepEqual(archived, [idle.id]);
    assert.ok(store.list().some((row) => row.id === live.id));
    assert.ok(store.list().some((row) => row.id === pinned.id));
    assert.ok((await store.tree("active")).sessions.some((session) => session.id === pinned.id));
    assert.ok(store.list().some((row) => row.id === kept.id));
    assert.equal(store.archived()[0].id, idle.id);
    const archiveId = store.archived()[0].archiveId;
    assert.ok(existsSync(join(store.archiveDir, archiveId, "agent.sqlite")));
    assert.equal((await store.settled(running.h, slow.id as number, 10000)).status, "done");
    const fresh = await store.create({ name: "Fresh", cwd: t.work, model: faux });
    assert.deepEqual(await store.sweepArchives(), []);
    assert.ok(store.list().some((row) => row.id === fresh.id));
    const restored = await store.restore(archiveId);
    assert.equal(restored.id, idle.id);
    assert.equal(store.archived().length, 0);
    assert.ok(existsSync(idle.dbPath));
    const agent = await store.resolveAgent(idle.id, "main");
    assert.match(JSON.stringify(await store.activeEntries(agent.c)), /remember this/);
  } finally {
    await store.close();
    map.close();
    await t.cleanup();
  }
});

test("startup sweeps old sessions and a configured keep-list protects an open client", async () => {
  const t = await tempStore();
  const keepPath = join(t.root, "keep.json");
  await writeFile(keepPath, JSON.stringify({ sessions: [] }));
  let now = Date.now();
  const options = { ...t.options, now: () => now, keepListFile: keepPath };
  let store = await Store.open(options);
  try {
    const old = await store.create({ name: "Old", cwd: t.work, model: faux });
    await store.close();
    now += 13 * 3_600_000;
    store = await Store.open(options);
    assert.equal(store.list().length, 0, "startup sweep archives idle sessions");
    const restored = await store.restore(store.archived()[0].archiveId);
    assert.equal(restored.id, old.id);
    await store.withSessionClient(old.id, async () => {
      assert.deepEqual(await store.sweepArchives(), [], "an open send/wait request protects the session");
    });
    await writeFile(keepPath, "not JSON");
    await assert.rejects(() => store.sweepArchives(), "a broken configured keep-list fails closed");
    assert.ok(store.list().some((row) => row.id === old.id));
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("REST pin, archive list and restore", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    const session = await (await fetch(`${server.base}/v1/sessions`, {
      method: "POST", headers, body: JSON.stringify({ name: "REST archive", cwd: t.work, model: faux }),
    })).json();
    const pin = await (await fetch(`${server.base}/v1/sessions/${session.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: true }),
    })).json();
    assert.equal(pin.pinned, true);
    assert.equal((await fetch(`${server.base}/v1/sessions/${session.id}`, { method: "DELETE", headers })).status, 409);
    const unpin = await (await fetch(`${server.base}/v1/sessions/${session.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ pinned: false }),
    })).json();
    assert.equal(unpin.pinned, false);
    assert.equal((await fetch(`${server.base}/v1/sessions/${session.id}`, { method: "DELETE", headers })).status, 200);
    const archives = await (await fetch(`${server.base}/v1/archive`, { headers })).json();
    assert.equal(archives[0].id, session.id);
    assert.equal(typeof archives[0].lastActivityAt, "number");
    const restored = await (await fetch(`${server.base}/v1/archive/${archives[0].archiveId}/restore`, { method: "POST", headers })).json();
    assert.equal(restored.id, session.id);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("archives moved by the older endpoint are indexed and can be restored", async () => {
  const t = await tempStore();
  let store = await t.open();
  try {
    const session = await store.create({ name: "Old archive", cwd: t.work, model: faux });
    const { archiveId } = await store.archive(store.row(session.id));
    store.catalog.prepare("DELETE FROM archived_sessions WHERE archiveId=?").run(archiveId);
    await store.close();
    store = await t.open();
    assert.equal(store.archived()[0].archiveId, archiveId);
    assert.equal((await store.restore(archiveId)).id, session.id);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
