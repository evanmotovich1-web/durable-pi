import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { backfillSessionActivity } from "../src/session-activity.js";
import { delay, faux, tempStore, until } from "./helpers.js";

test("legacy catalog backfills from a session database read-only, never file mtime", async () => {
  const t = await tempStore();
  const catalogPath = join(t.options.dataDir, "catalog.sqlite");
  const agentPath = join(t.options.dataDir, "sessions", "legacy", "agent.sqlite");
  await mkdir(dirname(agentPath), { recursive: true });
  const createdAt = Date.now() - 3_600_000;
  const entryAt = createdAt + 1000;
  const taskAt = createdAt + 2000;
  const agent = new DatabaseSync(agentPath);
  agent.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY,record TEXT); CREATE TABLE tasks(id INTEGER PRIMARY KEY,record TEXT)");
  agent.prepare("INSERT INTO entries VALUES(?,?)").run(1, JSON.stringify({ id: 1, model: [{ role: "assistant", timestamp: entryAt }] }));
  agent.prepare("INSERT INTO tasks VALUES(?,?)").run(2, JSON.stringify({ id: 2, state: { finishedAt: taskAt } }));
  agent.close();
  assert.equal(backfillSessionActivity(agentPath, createdAt), taskAt);
  const catalog = new DatabaseSync(catalogPath);
  catalog.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,cwd TEXT NOT NULL,dbPath TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL)");
  catalog.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)").run("legacy", "Legacy", t.work, agentPath, createdAt, "echo", "faux");
  catalog.close();
  const store = await t.open();
  try {
    assert.equal(store.row("legacy").lastActivityAt, taskAt);
    assert.equal((await store.sessionSummary(store.row("legacy"))).live, false);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("recorded message time survives restart; live work stays active", async () => {
  const t = await tempStore();
  const store = await Store.open({ ...t.options, sessionHideMinutes: 0 });
  try {
    const session = await store.create({ name: "Activity", cwd: t.work, model: faux });
    assert.equal(session.live, false);
    assert.equal(session.lastActivityAt, store.row(session.id).lastActivityAt);
    assert.ok(backfillSessionActivity(session.dbPath, session.createdAt) >= session.createdAt);
    store.catalog.prepare("UPDATE sessions SET lastActivityAt=? WHERE id=?").run(session.createdAt - 3_600_000, session.id);
    assert.equal((await store.tree("inactive")).sessions.length, 1);
    assert.equal((await store.tree("active")).sessions.length, 0);

    const { c, h } = await store.resolveAgent(session.id, "main");
    const sent = await store.send(c, { content: "!sleep 2; echo done", requestId: "activity-1" });
    const admittedAt = store.row(session.id).lastActivityAt;
    await until(async () => (await store.sessionSummary(store.row(session.id))).live, 5000, "live work");
    assert.equal((await store.tree("active")).sessions.length, 1);
    assert.ok(store.row(session.id).lastActivityAt > session.createdAt - 3_600_000);
    assert.equal((await store.settled(h, sent.id as number, 10000)).status, "done");
    assert.ok(store.row(session.id).lastActivityAt > admittedAt, "turn and tool completion advance activity time");
    await until(async () => !(await store.sessionSummary(store.row(session.id))).live, 5000, "idle");
    await delay(10);
    const beforeAgent = store.row(session.id).lastActivityAt;
    await store.createAgent(store.row(session.id), { name: "new" });
    assert.ok(store.row(session.id).lastActivityAt >= beforeAgent);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
